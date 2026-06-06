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
