/**
 * Phase 3 单测：会话中断检测与恢复
 *
 * P0-2（脏数据清洗管道）+ P1-5（interrupted_turn 完善）扩展：
 * 覆盖新增的清洗层（权限模式清洗 / 孤立 thinking 消息过滤 / content block 完整性校验）
 * 以及三态中断检测（none / interrupted_prompt / interrupted_turn）。
 */

import { describe, test, expect } from "bun:test";
import {
  deserializeMessagesWithInterruptDetection,
  TERMINAL_TOOL_NAMES,
} from "@sid-code/core/sdk/session-recovery.ts";
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

  test("终结性工具白名单：结果全部来自白名单工具时不算中断", () => {
    TERMINAL_TOOL_NAMES.add("Brief");
    try {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Brief", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
        },
      ];
      const r = deserializeMessagesWithInterruptDetection(messages);
      expect(r.turnInterruptionState.kind).toBe("none");
    } finally {
      TERMINAL_TOOL_NAMES.delete("Brief");
    }
  });

  test("终结性工具白名单：混合白名单与非白名单工具仍算中断", () => {
    TERMINAL_TOOL_NAMES.add("Brief");
    try {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Brief", input: {} },
            { type: "tool_use", id: "t2", name: "Bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "done" },
            { type: "tool_result", tool_use_id: "t2", content: "ok" },
          ],
        },
      ];
      const r = deserializeMessagesWithInterruptDetection(messages);
      expect(r.turnInterruptionState.kind).toBe("interrupted_turn");
    } finally {
      TERMINAL_TOOL_NAMES.delete("Brief");
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

  test("content block 完整性校验：缺失 id 的 tool_use 所在消息被丢弃", () => {
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
});
