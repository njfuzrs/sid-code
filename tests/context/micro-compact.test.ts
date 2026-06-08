/**
 * src/context/micro-compact.ts 单测
 */

import { describe, it, expect } from "bun:test";
import {
  microCompactDiscardable,
  isDiscardableTool,
  isNonDiscardableTool,
} from "../../src/context/micro-compact.ts";
import type { Message } from "../../src/llm/types.ts";

/** 辅助：构建含 tool_result 的消息列表 */
function makeMessages(count: number, toolName: string, contentLength: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    // user 消息含 tool_result
    msgs.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `tool_${i}`,
          content: "x".repeat(contentLength),
        },
      ],
    });
    // assistant 消息（纯文本）
    msgs.push({
      role: "assistant",
      content: [{ type: "text", text: `响应 ${i}` }],
    });
  }
  return msgs;
}

/** 辅助：构建含多种工具类型的消息列表 */
function makeMixedMessages(): Message[] {
  return [
    // tool_use 消息（供 tool_name 查询）
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_bash", name: "bash", input: {} },
        { type: "tool_use", id: "tool_read", name: "read", input: {} },
        { type: "tool_use", id: "tool_edit", name: "edit", input: {} },
        { type: "tool_use", id: "tool_write", name: "write", input: {} },
        { type: "tool_use", id: "tool_unknown", name: "unknown_tool", input: {} },
      ],
    },
    // user 消息含所有 tool_result
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_bash", content: "A".repeat(800) },
        { type: "tool_result", tool_use_id: "tool_read", content: "B".repeat(800) },
        { type: "tool_result", tool_use_id: "tool_edit", content: "C".repeat(800) },
        { type: "tool_result", tool_use_id: "tool_write", content: "D".repeat(800) },
        { type: "tool_result", tool_use_id: "tool_unknown", content: "E".repeat(800) },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  ];
}

describe("isDiscardableTool", () => {
  it("应识别 bash 为可丢弃工具", () => {
    expect(isDiscardableTool("bash")).toBe(true);
    expect(isDiscardableTool("Bash")).toBe(true);
    expect(isDiscardableTool("BASH")).toBe(true);
  });

  it("应识别 read 为可丢弃工具", () => {
    expect(isDiscardableTool("read")).toBe(true);
    expect(isDiscardableTool("file_read")).toBe(true);
  });

  it("应识别 grep 为可丢弃工具", () => {
    expect(isDiscardableTool("grep")).toBe(true);
  });

  it("应识别 edit 不是可丢弃工具", () => {
    expect(isDiscardableTool("edit")).toBe(false);
  });

  it("应识别 write 不是可丢弃工具", () => {
    expect(isDiscardableTool("write")).toBe(false);
  });

  it("未知工具应返回 false", () => {
    expect(isDiscardableTool("unknown_tool")).toBe(false);
  });
});

describe("isNonDiscardableTool", () => {
  it("应识别 edit 为不可丢弃工具", () => {
    expect(isNonDiscardableTool("edit")).toBe(true);
  });

  it("应识别 write 为不可丢弃工具", () => {
    expect(isNonDiscardableTool("write")).toBe(true);
  });

  it("应识别 bash 不是不可丢弃工具", () => {
    expect(isNonDiscardableTool("bash")).toBe(false);
  });
});

describe("microCompactDiscardable", () => {
  it("保护窗口内的消息不应被压缩", () => {
    const msgs = makeMessages(4, "bash", 1000);
    const result = microCompactDiscardable(msgs, { preserveRecentCount: 8, minContentLength: 500 });

    expect(result.compactedCount).toBe(0);
    expect(result.savedChars).toBe(0);
  });

  it("保护窗口外的可丢弃工具输出应被清空", () => {
    // 总共 8 条消息（4 个文件，每文件 2 条: user + assistant）
    // 保护最近 4 条（2 个文件），前 2 个文件应被压缩
    const msgs = makeMessages(5, "bash", 800);
    const result = microCompactDiscardable(msgs, { preserveRecentCount: 6, minContentLength: 500 });

    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.savedChars).toBeGreaterThan(0);
  });

  it("不可丢弃工具输出应保留摘要", () => {
    // 5 条消息，preserveRecentCount=2 → cutoff=3 → idx 0,1,2 被处理
    // idx 0: user text (无 tool_result → 跳过)
    // idx 1: assistant tool_use (role=assistant → 跳过)
    // idx 2: user tool_result (role=user + tool_result → 被压缩!)
    // idx 3,4: 保护窗口内
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "padding" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_edit", name: "edit", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_edit", content: "X".repeat(800) }],
      },
      { role: "assistant", content: [{ type: "text", text: "resp 1" }] },
      { role: "assistant", content: [{ type: "text", text: "resp 2" }] },
    ];

    const result = microCompactDiscardable(msgs, { preserveRecentCount: 2, minContentLength: 500 });
    expect(result.compactedCount).toBe(1);

    // tool_result 在 idx 2
    const compacted = result.messages[2].content[0];
    if (compacted.type === "tool_result") {
      expect(compacted.content).toContain("X".repeat(200));
      expect(compacted.content).toContain("已省略");
    }
  });

  it("小于 minContentLength 的输出不应被压缩", () => {
    const msgs = makeMessages(10, "bash", 100);
    const result = microCompactDiscardable(msgs, { preserveRecentCount: 2, minContentLength: 500 });

    expect(result.compactedCount).toBe(0);
  });

  it("空消息列表应返回空结果", () => {
    const result = microCompactDiscardable([], {});

    expect(result.compactedCount).toBe(0);
    expect(result.savedChars).toBe(0);
    expect(result.tokenEstimateFreed).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("混合工具类型应正确处理", () => {
    const result = microCompactDiscardable(makeMixedMessages(), {
      preserveRecentCount: 0,
      minContentLength: 500,
    });

    // bash ≈ 可丢弃, read ≈ 可丢弃, edit/write ≈ 不可丢弃, unknown ≈ 通用占位符
    // 所有 5 个都应该被压缩（因为 protectRecent=0）
    expect(result.compactedCount).toBe(5);
    expect(result.savedChars).toBeGreaterThan(0);
  });

  it("不应修改原始消息数组", () => {
    const msgs = makeMessages(4, "bash", 800);
    const originalFirst = msgs[0].content[0];
    const originalContent = originalFirst.type === "tool_result" ? originalFirst.content : "";

    microCompactDiscardable(msgs, { preserveRecentCount: 2, minContentLength: 500 });

    // 原始数组不受影响
    const after = msgs[0].content[0];
    const afterContent = after.type === "tool_result" ? after.content : "";
    expect(afterContent).toBe(originalContent);
  });

  it("tokenEstimateFreed 应粗略为正比关系", () => {
    const msgs = makeMessages(10, "bash", 1000);
    const result = microCompactDiscardable(msgs, { preserveRecentCount: 2, minContentLength: 500 });

    expect(result.tokenEstimateFreed).toBeGreaterThan(0);
    // ~4 字符 = 1 token 的粗略估算
    expect(result.tokenEstimateFreed).toBeLessThanOrEqual(Math.ceil(result.savedChars / 4) + 1);
  });
});
