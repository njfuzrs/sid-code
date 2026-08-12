/**
 * 消息历史不变量纯函数测试 — D1-4
 *
 * 覆盖 src/agent/message-invariants.ts：
 *   - 完整历史（基线）
 *   - 孤儿 tool_use（OpenAI 400 直接成因）
 *   - 游离 tool_result（无前置 tool_use）
 *   - 多轮累积 + 跨消息配对
 *   - assertMessageHistoryIntact 抛 MessageHistoryViolationError
 */

import { describe, test, expect } from "bun:test";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  checkMessageHistoryIntegrity,
  hasOrphanToolUse,
  assertMessageHistoryIntact,
  describeIntegrityViolation,
  backfillOrphanToolResults,
  safeSliceTail,
  MessageHistoryViolationError,
} from "@sid-code/core/agent/message-invariants.ts";

function asst(...tools: Array<[string, string]>): Message {
  return {
    role: "assistant",
    content: tools.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })),
  };
}

function userResults(...ids: string[]): Message {
  return {
    role: "user",
    content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })),
  };
}

describe("D1-4 — 消息历史不变量纯函数", () => {
  test("基线：每个 tool_use 都有对应 tool_result → intact", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      asst(["c1", "read"], ["c2", "grep"]),
      userResults("c1", "c2"),
    ];
    const r = checkMessageHistoryIntegrity(messages);
    expect(r.intact).toBe(true);
    expect(r.orphans).toHaveLength(0);
    expect(r.dangling).toHaveLength(0);
    expect(hasOrphanToolUse(messages)).toBe(false);
  });

  test("孤儿 tool_use：assistant 有 tool_use 但无对应 tool_result", () => {
    const messages: Message[] = [
      asst(["c1", "read"], ["c2", "boom"]),
      userResults("c1"), // c2 缺失
    ];
    const r = checkMessageHistoryIntegrity(messages);
    expect(r.intact).toBe(false);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].id).toBe("c2");
    expect(r.orphans[0].name).toBe("boom");
    expect(r.orphans[0].messageIndex).toBe(0);
    expect(hasOrphanToolUse(messages)).toBe(true);
  });

  test("游离 tool_result：tool_result 无前置 tool_use", () => {
    const messages: Message[] = [
      asst(["c1", "read"]),
      userResults("c1", "ghost"), // ghost 无对应 tool_use
    ];
    const r = checkMessageHistoryIntegrity(messages);
    expect(r.intact).toBe(false);
    expect(r.orphans).toHaveLength(0);
    expect(r.dangling).toHaveLength(1);
    expect(r.dangling[0].toolUseId).toBe("ghost");
  });

  test("多轮累积：跨多轮 tool_use/tool_result 全配对 → intact", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      asst(["a1", "read"]),
      userResults("a1"),
      asst(["b1", "edit"], ["b2", "read"]),
      userResults("b1", "b2"),
      asst(["c1", "bash"]),
      userResults("c1"),
    ];
    expect(checkMessageHistoryIntegrity(messages).intact).toBe(true);
  });

  test("中断真实场景：最后一轮 tool_use 完全没有 tool_result（孤儿）", () => {
    // 模拟本次 bug：assistant tool_calls 已 addMessage，但 executeTools 被中断切开
    const messages: Message[] = [
      asst(["a1", "read"]),
      userResults("a1"),
      asst(["x1", "edit"], ["x2", "write"]), // 这一轮被中断，无 tool_result
    ];
    const r = checkMessageHistoryIntegrity(messages);
    expect(r.intact).toBe(false);
    expect(r.orphans.map((o) => o.id).sort()).toEqual(["x1", "x2"]);
  });

  test("assertMessageHistoryIntact：完整时不抛", () => {
    const messages: Message[] = [asst(["c1", "read"]), userResults("c1")];
    expect(() => assertMessageHistoryIntact(messages, "test")).not.toThrow();
  });

  test("assertMessageHistoryIntact：有孤儿时抛 MessageHistoryViolationError 且带 detail", () => {
    const messages: Message[] = [asst(["c1", "read"], ["c2", "boom"]), userResults("c1")];
    let thrown: unknown = null;
    try {
      assertMessageHistoryIntact(messages, "openai");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MessageHistoryViolationError);
    const err = thrown as MessageHistoryViolationError;
    expect(err.message).toContain("openai");
    expect(err.detail.orphans).toHaveLength(1);
    expect(err.detail.orphans[0].id).toBe("c2");
  });

  test("describeIntegrityViolation：可读摘要含 id/name/位置", () => {
    const messages: Message[] = [asst(["c1", "read"], ["c2", "boom"]), userResults("c1")];
    const r = checkMessageHistoryIntegrity(messages);
    const desc = describeIntegrityViolation(r);
    expect(desc).toContain("孤儿");
    expect(desc).toContain("c2");
    expect(desc).toContain("boom");
  });

  test("空历史 / 纯文本历史 → intact", () => {
    expect(checkMessageHistoryIntegrity([]).intact).toBe(true);
    expect(
      checkMessageHistoryIntegrity([
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]).intact,
    ).toBe(true);
  });
});

describe("backfillOrphanToolResults — 生产端孤儿兜底", () => {
  test("无孤儿 → changed=false 且原样返回引用", () => {
    const messages: Message[] = [asst(["c1", "read"]), userResults("c1")];
    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(false);
    expect(r.messages).toBe(messages); // 同一引用，零拷贝
    expect(r.backfilled).toHaveLength(0);
  });

  test("末尾孤儿且其后无 user 消息 → 插入一条新 user 消息承载占位", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      asst(["c1", "bash"], ["c2", "bash"]), // 两个 tool_use 都无应答
    ];
    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(true);
    expect(r.backfilled).toHaveLength(2);
    // 修补后历史必须完整
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    // 末尾应是一条 user 消息，含 2 个 error 占位 tool_result
    const last = r.messages[r.messages.length - 1];
    expect(last.role).toBe("user");
    const trs = last.content.filter((b) => b.type === "tool_result");
    expect(trs).toHaveLength(2);
    expect(trs.every((b) => b.type === "tool_result" && b.is_error === true)).toBe(true);
  });

  test("部分应答（仅缺其中一个）→ 占位合并进紧邻的已有 user 消息，不破坏角色交替", () => {
    const messages: Message[] = [
      asst(["c1", "read"], ["c2", "boom"]),
      userResults("c1"), // c2 缺失
    ];
    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(true);
    expect(r.backfilled).toHaveLength(1);
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    // 消息条数不增加（合并进已有 user 消息，而非新插一条 → 不产生 user/user）
    expect(r.messages).toHaveLength(2);
    // 不存在相邻同角色
    for (let i = 1; i < r.messages.length; i++) {
      expect(r.messages[i].role).not.toBe(r.messages[i - 1].role);
    }
  });

  test("复刻崩溃现场：assistant(text + 4 个 bash tool_use) 后紧跟纯 text user(循环恢复提示) → 补齐后 intact", () => {
    // 这是 28b7eed7 session 21:28 崩溃的真实结构（msg#25 assistant 4 孤儿，msg#26 纯 text user）
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "现在验证 KeypressContext 和 InputArea" },
          { type: "tool_use", id: "call_00", name: "bash", input: { command: "rg escape ..." } },
          { type: "tool_use", id: "call_01", name: "bash", input: { command: "rg escape ..." } },
          { type: "tool_use", id: "call_02", name: "bash", input: { command: "git diff ..." } },
          { type: "tool_use", id: "call_03", name: "bash", input: { command: "git diff ..." } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "系统检测到你陷入了非生产性循环…" }] },
    ];
    // 修补前：4 个孤儿（正是 OpenAI 400 的成因）
    expect(checkMessageHistoryIntegrity(messages).orphans).toHaveLength(4);

    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(true);
    expect(r.backfilled).toHaveLength(4);
    // 修补后：完整，且不再有相邻同角色
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    for (let i = 1; i < r.messages.length; i++) {
      expect(r.messages[i].role).not.toBe(r.messages[i - 1].role);
    }
    // 4 个占位 tool_result 应合并进 assistant 之后那条已有 user 消息（排在恢复提示文本之前）
    const merged = r.messages[1];
    expect(merged.role).toBe("user");
    expect(merged.content.filter((b) => b.type === "tool_result")).toHaveLength(4);
    expect(merged.content.some((b) => b.type === "text")).toBe(true);
  });

  test("幂等：对已补齐的历史再跑一次 → changed=false", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      asst(["c1", "bash"]),
    ];
    const once = backfillOrphanToolResults(messages);
    expect(once.changed).toBe(true);
    const twice = backfillOrphanToolResults(once.messages);
    expect(twice.changed).toBe(false);
  });

  test("不修改入参数组（纯函数）", () => {
    const messages: Message[] = [asst(["c1", "bash"])];
    const before = messages.length;
    backfillOrphanToolResults(messages);
    expect(messages).toHaveLength(before);
    expect(messages[0].content.every((b) => b.type === "tool_use")).toBe(true);
  });
});

describe("backfillOrphanToolResults — 游离 tool_result 切除（Session 0427d1bd 400 根因）", () => {
  test("无游离无孤儿 → changed=false 且 stripped 为空", () => {
    const messages: Message[] = [asst(["c1", "read"]), userResults("c1")];
    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(false);
    expect(r.stripped).toHaveLength(0);
    expect(r.backfilled).toHaveLength(0);
  });

  test("首条游离 tool_result（复刻 0427d1bd：slice 起点是 user+游离 tool_result）→ 整条切除", () => {
    // 切片把 tool_use 切掉了，只留下其 tool_result 在首条 → 游离
    const messages: Message[] = [
      userResults("dangling_ref"), // 游离：dangling_ref 的 tool_use 已被切掉
      asst(["c1", "read"]),
      userResults("c1"),
    ];
    expect(checkMessageHistoryIntegrity(messages).dangling).toHaveLength(1);

    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(true);
    expect(r.stripped).toHaveLength(1);
    expect(r.stripped[0].toolUseId).toBe("dangling_ref");
    // 切除后历史完整，首条不再是游离
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    // 首条游离被整条删除（content 仅含该游离 tool_result，剥空 → 删除）
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe("assistant");
  });

  test("游离在中间位置（snipCompact 挖中段后拼接处）→ 精确切除该 block，保留同消息其它内容", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      asst(["c1", "read"]),
      // 这条 user 同时含 c1 的合法 tool_result + 一个游离 tool_result + 文本
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "ok" },
          { type: "tool_result", tool_use_id: "dangling_mid", content: "orphaned" },
          { type: "text", text: "继续" },
        ],
      },
    ];
    expect(checkMessageHistoryIntegrity(messages).dangling).toHaveLength(1);

    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(true);
    expect(r.stripped).toHaveLength(1);
    expect(r.stripped[0].toolUseId).toBe("dangling_mid");
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    // 消息条数不变（只剥 block，不删整条——因为还有合法 tool_result + text）
    expect(r.messages).toHaveLength(3);
    const mid = r.messages[2];
    // c1 合法 tool_result 与文本保留，游离被剥
    expect(mid.content.filter((b) => b.type === "tool_result")).toHaveLength(1);
    expect(mid.content.some((b) => b.type === "tool_result" && b.tool_use_id === "c1")).toBe(true);
    expect(mid.content.some((b) => b.type === "text")).toBe(true);
  });

  test("游离 + 孤儿共存 → 先切游离再补孤儿，下标不漂移，最终 intact", () => {
    const messages: Message[] = [
      userResults("dangling_ref"), // 游离（首条）
      asst(["c1", "read"], ["c2", "bash"]), // c2 将成孤儿
      userResults("c1"), // 只应答 c1，c2 缺失
    ];
    const integrity = checkMessageHistoryIntegrity(messages);
    expect(integrity.dangling).toHaveLength(1);
    expect(integrity.orphans).toHaveLength(1);

    const r = backfillOrphanToolResults(messages);
    expect(r.changed).toBe(true);
    expect(r.stripped).toHaveLength(1); // dangling_ref 被切
    expect(r.backfilled).toHaveLength(1); // c2 被补占位
    expect(r.backfilled[0].id).toBe("c2");
    // 最终完整且无相邻同角色
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    for (let i = 1; i < r.messages.length; i++) {
      expect(r.messages[i].role).not.toBe(r.messages[i - 1].role);
    }
  });

  test("幂等：对已切除游离的历史再跑一次 → changed=false", () => {
    const messages: Message[] = [
      userResults("dangling_ref"),
      asst(["c1", "read"]),
      userResults("c1"),
    ];
    const once = backfillOrphanToolResults(messages);
    expect(once.changed).toBe(true);
    const twice = backfillOrphanToolResults(once.messages);
    expect(twice.changed).toBe(false);
  });

  test("不修改入参数组（切游离也是纯函数）", () => {
    const messages: Message[] = [
      userResults("dangling_ref"),
      asst(["c1", "read"]),
      userResults("c1"),
    ];
    const beforeLen = messages.length;
    const beforeFirstBlocks = messages[0].content.length;
    backfillOrphanToolResults(messages);
    expect(messages).toHaveLength(beforeLen);
    expect(messages[0].content).toHaveLength(beforeFirstBlocks);
  });
});

describe("safeSliceTail — 安全尾部切片（保证起点不是游离 tool_result）", () => {
  // 构造一串干净的配对消息：user(text) + N×[asst(tool_use) + user(tool_result)]
  function buildPairs(n: number): Message[] {
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "start" }] }];
    for (let i = 0; i < n; i++) {
      msgs.push(asst([`c${i}`, "read"]));
      msgs.push(userResults(`c${i}`));
    }
    return msgs;
  }

  test("消息数 <= n → 原样返回（拷贝）", () => {
    const messages = buildPairs(2); // 5 条
    const r = safeSliceTail(messages, 15);
    expect(r).toHaveLength(messages.length);
    expect(checkMessageHistoryIntegrity(r).intact).toBe(true);
  });

  test("起点本就干净（落在 assistant）→ 切片不产生游离", () => {
    const messages = buildPairs(10); // 1 + 20 = 21 条
    const r = safeSliceTail(messages, 15);
    // 切片内无游离（起点可能是 asst 孤儿，但绝不是游离 tool_result）
    expect(checkMessageHistoryIntegrity(r).dangling).toHaveLength(0);
  });

  test("slice(-N) 起点恰为 user+tool_result（游离）→ 起点对齐，消除游离", () => {
    // 构造 16 条，使 slice(-15) 起点落在 user(tool_result) 上
    const messages: Message[] = [
      asst(["c0", "read"]), // 0 ← slice(-15) 会把它切掉
      userResults("c0"), // 1 ← slice(-15) 起点（游离！c0 的 tool_use 在第 0 条被切）
    ];
    for (let i = 1; i < 8; i++) {
      messages.push(asst([`c${i}`, "read"]));
      messages.push(userResults(`c${i}`));
    }
    // 共 2 + 14 = 16 条；slice(-15) 起点 = index 1（userResults c0，游离）
    expect(messages).toHaveLength(16);
    const naive = messages.slice(-15);
    expect(checkMessageHistoryIntegrity(naive).dangling.length).toBeGreaterThan(0);

    const safe = safeSliceTail(messages, 15);
    // 安全切片消除游离（向前扩展纳入 c0 的 tool_use，或收缩跳过游离）
    expect(checkMessageHistoryIntegrity(safe).dangling).toHaveLength(0);
  });

  test("向前扩展即可纳入 tool_use（maxExpand 内）→ 保留完整配对而非丢数据", () => {
    // slice(-3) 起点是 user(tool_result c_last)，其 tool_use 在前一条 → 扩展 1 条即可
    const messages = buildPairs(5); // 11 条
    const safe = safeSliceTail(messages, 3);
    expect(checkMessageHistoryIntegrity(safe).dangling).toHaveLength(0);
    // 起点应是 assistant（向前扩展纳入了 tool_use），而非被收缩丢弃
    expect(safe[0].role).toBe("assistant");
  });

  test("纯函数：不修改入参", () => {
    const messages = buildPairs(10);
    const before = messages.length;
    safeSliceTail(messages, 15);
    expect(messages).toHaveLength(before);
  });
});
