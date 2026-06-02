/**
 * message-normalizer.ts 测试
 * tool_use/tool_result 配对修复 / 角色交替合并 / 媒体限制 / 空块清理 / 不改原始消息
 */

import { describe, test, expect } from "bun:test";
import {
  normalizeMessagesForAPI,
  ensureToolResultPairing,
  ensureAlternatingRoles,
  limitMediaCount,
  removeEmptyContentBlocks,
} from "../../src/api/message-normalizer.ts";
import type { Message } from "../../src/llm/types.ts";

describe("ensureToolResultPairing", () => {
  test("缺失 tool_result 时补占位（下一条是 user）", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "text", text: "结果" }] },
    ];
    const result = ensureToolResultPairing(messages);
    const userMsg = result[1];
    const trs = userMsg.content.filter((b) => b.type === "tool_result");
    expect(trs.length).toBe(1);
    expect((trs[0] as any).tool_use_id).toBe("t1");
    expect((trs[0] as any).is_error).toBe(true);
  });

  test("assistant 后无 user 消息 → 插入新 user 消息", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result.length).toBe(2);
    expect(result[1].role).toBe("user");
    expect(result[1].content[0].type).toBe("tool_result");
  });

  test("已配对则不改动", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result[1].content.length).toBe(1);
  });

  test("部分缺失只补缺失的", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "read", input: {} },
          { type: "tool_use", id: "t2", name: "write", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    const result = ensureToolResultPairing(messages);
    const ids = result[1].content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b as any).tool_use_id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
  });
});

describe("ensureAlternatingRoles", () => {
  test("合并相邻同角色消息", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
    ];
    const result = ensureAlternatingRoles(messages);
    expect(result.length).toBe(2);
    expect(result[0].content.length).toBe(2);
    expect(result[1].role).toBe("assistant");
  });

  test("已交替则不变", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ];
    expect(ensureAlternatingRoles(messages).length).toBe(2);
  });
});

describe("limitMediaCount", () => {
  test("超出从最早消息移除", () => {
    // 构造 3 个媒体块，限制为 2
    const mk = (id: string): any => ({ type: "image", source: id });
    const messages: Message[] = [
      { role: "user", content: [mk("1"), { type: "text", text: "x" }] },
      { role: "user", content: [mk("2")] },
      { role: "user", content: [mk("3")] },
    ];
    const result = limitMediaCount(messages, 2);
    let count = 0;
    for (const m of result) for (const b of m.content) if ((b as any).type === "image") count++;
    expect(count).toBe(2);
    // 最早的媒体（第一条里的）被移除，但文本保留
    expect(result[0].content.some((b) => b.type === "text")).toBe(true);
    expect(result[0].content.some((b) => (b as any).type === "image")).toBe(false);
  });

  test("未超限不改动", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "x" }] },
    ];
    expect(limitMediaCount(messages, 100)).toBe(messages);
  });
});

describe("removeEmptyContentBlocks", () => {
  test("移除空文本块 + 空消息", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "keep" }] },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ];
    const result = removeEmptyContentBlocks(messages);
    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
    expect((result[0].content[0] as any).text).toBe("keep");
  });

  test("保留 tool_use / tool_result 块", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    ];
    expect(removeEmptyContentBlocks(messages).length).toBe(1);
  });
});

describe("normalizeMessagesForAPI 不修改原始消息", () => {
  test("原始消息数组与内容不被修改", () => {
    const original: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const snapshot = JSON.stringify(original);
    normalizeMessagesForAPI(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("端到端：配对 + 清理空块", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    ];
    const result = normalizeMessagesForAPI(messages);
    // 空文本被清，q 保留，tool_use 补了 tool_result
    const hasToolResult = result.some((m) =>
      m.content.some((b) => b.type === "tool_result"),
    );
    expect(hasToolResult).toBe(true);
  });
});
