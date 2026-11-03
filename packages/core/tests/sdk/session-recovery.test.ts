/**
 * Phase 3 单测：会话中断检测与恢复
 *
 * P0-2（脏数据清洗管道）+ P1-5（interrupted_turn 完善）扩展：
 * 覆盖新增的清洗层（权限模式清洗 / 孤立 thinking 消息过滤 / content block 完整性校验）
 * 以及三态中断检测（none / interrupted_prompt / interrupted_turn）。
 */

import { describe, test, expect } from "bun:test";
import { deserializeMessagesWithInterruptDetection } from "@sid-code/core/sdk/session-recovery.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";
import { PERMISSION_MODE_VALUES } from "@sid-code/core/permission/mode.ts";
import { PERMISSION_MODES } from "@sid-code/core/config/schema.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

describe("deserializeMessagesWithInterruptDetection", () => {
  test("空历史", () => {
    const r = deserializeMessagesWithInterruptDetection([]);
    expect(r.messages).toEqual([]);
    expect(r.turnInterruptionState.kind).toBe("none");
  });

  test("过滤未解析的 tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
      // 注意：没有 t1 的 tool_result
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const assistant = r.messages.find((m) => m.role === "assistant")!;
    // tool_use 被过滤，只剩 text
    expect(assistant.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("保留已解析的 tool_use", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const assistant = r.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content.some((b) => b.type === "tool_use")).toBe(true);
    // 末尾是 tool_result 且无后续回复 → 现在归类为 interrupted_turn（P1-5），
    // 不再是 "none"（旧行为未区分"工具做完但没回复"与"正常结束"两种情况）。
    expect(r.turnInterruptionState.kind).toBe("interrupted_turn");
  });

  test("过滤空白助手消息（全部 tool_use 未解析）", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    // 末尾用户消息也被识别为中断；助手消息因清空被丢弃
    expect(r.messages.every((m) => m.role !== "assistant")).toBe(true);
  });

  test("末尾纯用户输入 → interrupted_prompt", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2 中断了" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("interrupted_prompt");
    if (r.turnInterruptionState.kind === "interrupted_prompt") {
      expect(r.turnInterruptionState.message.content).toEqual([
        { type: "text", text: "q2 中断了" },
      ]);
    }
    // 中断的用户消息从 messages 中移除（交由 turnInterruptionState 持有）
    expect(r.messages.length).toBe(2);
  });

  test("末尾正常 assistant 回复 → none", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("none");
  });

  // ─── P1-5：interrupted_turn（工具执行完但还没来得及回复） ───

  test("末尾用户消息含 tool_result 且无后续回复 → interrupted_turn，携带工具名", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("interrupted_turn");
    if (r.turnInterruptionState.kind === "interrupted_turn") {
      expect(r.turnInterruptionState.lastToolNames).toEqual(["Bash"]);
    }
    // interrupted_turn 不移除任何消息（工具结果本身是合法历史，只是缺少下一条回复）
    expect(r.messages.length).toBe(2);
  });

  test("并行多工具调用全部完成但未回复 → interrupted_turn 携带全部工具名", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file content" },
          { type: "tool_result", tool_use_id: "t2", content: "ok" },
        ],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("interrupted_turn");
    if (r.turnInterruptionState.kind === "interrupted_turn") {
      expect(r.turnInterruptionState.lastToolNames.sort()).toEqual(["Bash", "Read"]);
    }
  });

  // ─── P0-2：脏数据清洗管道各层 ───

  test("权限模式清洗：失效的 permissionMode 被清理但消息保留", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        _meta: { permissionMode: "some-removed-mode" },
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const userMsg = r.messages.find((m) => m.role === "user")!;
    expect((userMsg._meta as any)?.permissionMode).toBeUndefined();
    expect(userMsg.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("权限模式清洗：合法模式保留不变", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        _meta: { permissionMode: "plan" },
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const userMsg = r.messages.find((m) => m.role === "user")!;
    expect((userMsg._meta as any)?.permissionMode).toBe("plan");
  });

  test("孤立 thinking-only 消息过滤：仅含 thinking block 的 assistant 消息被丢弃", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "想想看" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "让我想想…" }],
        // 注意：流式中断，没有后续文本/工具调用
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.messages.every((m) => m.role !== "assistant")).toBe(true);
  });

  test("thinking block 与正文并存时保留整条消息", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "想想看" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "让我想想…" },
          { type: "text", text: "答案是 42" },
        ],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const assistant = r.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content.some((b) => b.type === "text")).toBe(true);
    expect(assistant.content.some((b) => b.type === "thinking")).toBe(true);
  });

  test("content block 完整性校验：缺失 id 的 tool_use 被剔除，剥空的消息整条丢弃", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "", name: "Bash", input: {} }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.messages.every((m) => m.role !== "assistant")).toBe(true);
  });

  test("content block 完整性校验：id/tool_use_id 均为空字符串时兜底剔除", () => {
    // filterUnresolvedToolUses 按 Set.has() 匹配 tool_use_id，空字符串会"互相匹配"从而
    // 被误判为已解析、逃过第 3 层——这类残缺标识符最终要靠第 6 层完整性校验兜底剔除。
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "", content: "ok" }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.messages.length).toBe(0);
  });

  // ─── 缺陷 12：第 6 层只剔坏 block，不连坐同条消息里的好 block ───

  test("缺陷 12：同条里一个坏 tool_use 不会带走好 tool_use 及其结果", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "干活" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ok1", name: "Read", input: {} },
          { type: "tool_use", id: "bad1", name: "", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "ok1", content: "内容" },
          { type: "tool_result", tool_use_id: "bad1", content: "内容" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "做完了" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    // 出口不变量：无孤儿 tool_use、无游离 tool_result
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    const uses = r.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_use").map((b) => (b as any).id),
    );
    const results = r.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result").map((b) => (b as any).tool_use_id),
    );
    expect(uses).toEqual(["ok1"]);
    expect(results).toEqual(["ok1"]);
    expect(r.messages.length).toBe(4);
    expect(r.turnInterruptionState.kind).toBe("none");
  });

  test("缺陷 12：坏 tool_use 旁边的正文保留，其游离结果被切除", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "干活" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我来读一下" },
          { type: "tool_use", id: "t1", name: "", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.messages[1].content).toEqual([{ type: "text", text: "我来读一下" }]);
    expect(r.turnInterruptionState.kind).toBe("none");
  });

  // ─── 缺陷 13：权限模式白名单取自枚举 ───

  test("缺陷 13：PermissionMode 的每个真实值都不会被当成失效模式清洗", () => {
    for (const mode of PERMISSION_MODE_VALUES) {
      const r = deserializeMessagesWithInterruptDetection([
        { role: "user", content: [{ type: "text", text: "hi" }], _meta: { permissionMode: mode } },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]);
      expect((r.messages[0]._meta as any)?.permissionMode).toBe(mode);
    }
  });

  test("缺陷 13：CC 的模式名 bypassPermissions 不是本仓模式，会被清洗", () => {
    const r = deserializeMessagesWithInterruptDetection([
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        _meta: { permissionMode: "bypassPermissions" },
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
    expect((r.messages[0]._meta as any)?.permissionMode).toBeUndefined();
  });

  test("缺陷 13：运行时清单与配置层清单一致（配置层多一个 CC 别名 manual）", () => {
    const config = new Set<string>(PERMISSION_MODES);
    config.delete("manual");
    expect([...PERMISSION_MODE_VALUES].map(String).sort()).toEqual([...config].sort());
  });

  // ─── 缺陷 15：工具名按 tool_use_id 反查，不依赖「倒数第二条」 ───

  test("缺陷 15：发出 tool_use 的 assistant 不在倒数第二条时仍能反查到工具名", () => {
    // 中间夹一条纯文本 user 消息（跨轮/合并出来的历史形状），
    // 旧实现只看 messages[len-2] → 不是 assistant → 返回 []。
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "先跑个命令" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "执行中" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "顺带一句备注" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("interrupted_turn");
    if (r.turnInterruptionState.kind === "interrupted_turn") {
      expect(r.turnInterruptionState.lastToolNames).toEqual(["Bash"]);
    }
  });

  test("缺陷 15：多个 id 且 assistant 位置错位时，工具名按 tool_result 顺序全部返回", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "批量读" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
          { type: "tool_use", id: "t3", name: "Grep", input: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "中途插入的文本" }] },
      { role: "assistant", content: [{ type: "text", text: "结果整理中" }] },
      {
        role: "user",
        content: [
          // 故意打乱相对顺序：返回顺序应跟随 tool_result，而不是 tool_use 的声明顺序
          { type: "tool_result", tool_use_id: "t3", content: "grep 结果" },
          { type: "tool_result", tool_use_id: "t1", content: "文件内容" },
          { type: "tool_result", tool_use_id: "t2", content: "ok" },
        ],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("interrupted_turn");
    if (r.turnInterruptionState.kind === "interrupted_turn") {
      expect(r.turnInterruptionState.lastToolNames).toEqual(["Grep", "Read", "Bash"]);
    }
  });

  // ─── 缺陷 16：第 3 层必须顺序敏感（按 tool_use 之后是否有 result 配对） ───

  test("缺陷 16：tool_result 排在 tool_use 之前时，该 tool_use 不被集合判据洗白", () => {
    // 脏历史：结果在前、调用在后。集合判据会认为 t1「已解析」而放行，API 按顺序仍报 400。
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "早到的结果" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      { role: "assistant", content: [{ type: "text", text: "结束" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    // 旧实现会把 t1 判成已解析（集合里存在）→ 这里会看到一堆 tool_use
    const toolUseIds = r.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_use").map((b) => (b as any).id),
    );
    expect(toolUseIds).toEqual([]);
    // 前置的游离 tool_result 由第 7 层切除，出口不变量成立
    const toolResultIds = r.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result").map((b) => (b as any).tool_use_id),
    );
    expect(toolResultIds).toEqual([]);
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
  });

  test("缺陷 16：跨轮同 id 复用时第二个 tool_use 未被上一轮的结果洗白而漏过滤", () => {
    // 第一轮的 t1 已正常配对；末尾第二轮又用了同 id 且没有 result。
    // 集合判据只因「历史里存在 t1 的 result」就放行末尾这条 → 漏过滤。
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "第一轮" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "第一轮做完" }] },
      { role: "user", content: [{ type: "text", text: "第二轮" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    // 第一个 t1 属于第一轮、其后紧随 result → 保留
    expect(r.messages[1].role).toBe("assistant");
    expect(r.messages[1].content.some((b) => b.type === "tool_use" && b.id === "t1")).toBe(true);
    // 末尾第二个 t1 无 result → 被剔除，整条消息被第 5 层丢弃；全历史只剩一个 tool_use
    expect(r.messages.filter((m) => m.content.some((b) => b.type === "tool_use")).length).toBe(1);
    expect(r.messages.length).toBe(4);
    // 末尾 assistant 整条被丢弃后，历史末尾回到第二轮的 user 文本「第二轮」——
    // 用户问了但没等到回复，三态判定为 interrupted_prompt（该 user 消息被切出由调用方重挂）。
    // 关键点是**不再误报「在跑 Bash」**：第二个 tool_use 确实被剔除了。
    expect(r.turnInterruptionState.kind).toBe("interrupted_prompt");
  });

  // ─── 回归：正常形状的配对必须原样保留 ───

  test("回归：正常顺序的单工具调用与结果全部保留", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "跑一下" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "完成" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.messages.length).toBe(4);
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    expect(r.turnInterruptionState.kind).toBe("none");
  });

  test("回归：正常顺序的并行多工具调用全部保留（同一条 assistant 消息里）", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "并行" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
          { type: "tool_use", id: "t3", name: "Grep", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "a" },
          { type: "tool_result", tool_use_id: "t2", content: "b" },
          { type: "tool_result", tool_use_id: "t3", content: "c" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "汇总" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const toolUseIds = r.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_use").map((b) => (b as any).id),
    );
    expect(toolUseIds).toEqual(["t1", "t2", "t3"]);
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    expect(r.turnInterruptionState.kind).toBe("none");
  });
});
