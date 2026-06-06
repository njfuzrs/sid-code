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
import type { Message } from "../../src/llm/types.ts";
import {
  checkMessageHistoryIntegrity,
  hasOrphanToolUse,
  assertMessageHistoryIntact,
  describeIntegrityViolation,
  backfillOrphanToolResults,
  MessageHistoryViolationError,
} from "../../src/agent/message-invariants.ts";

function asst(...tools: Array<[string, string]>): Message {
  return {
    role: "assistant",
    content: tools.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })),
  };
}

function userResults(...ids: string[]): Message {
  return {
    role: "user",
    content: ids.map(id => ({ type: "tool_result", tool_use_id: id, content: "ok" })),
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
    expect(r.orphans.map(o => o.id).sort()).toEqual(["x1", "x2"]);
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
    const trs = last.content.filter(b => b.type === "tool_result");
    expect(trs).toHaveLength(2);
    expect(trs.every(b => b.type === "tool_result" && b.is_error === true)).toBe(true);
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
    expect(merged.content.filter(b => b.type === "tool_result")).toHaveLength(4);
    expect(merged.content.some(b => b.type === "text")).toBe(true);
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
    expect(messages[0].content.every(b => b.type === "tool_use")).toBe(true);
  });
});
