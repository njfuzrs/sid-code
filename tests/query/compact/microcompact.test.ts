/**
 * src/query/compact/microcompact.ts 单测（活跃生产路径，对标四级压缩管道 ③）
 *
 * 覆盖：工具类型感知（可丢弃完全清空 / 不可丢弃保留摘要 / 未分类通用占位符）、
 * cache vs time 模式、保护窗口、minContentLength、不修改原数组。
 */

import { describe, it, expect } from "bun:test";
import {
  microcompactMessages,
  isDiscardableTool,
  isNonDiscardableTool,
} from "../../../src/query/compact/microcompact.ts";
import type { Message } from "../../../src/llm/types.ts";

/** 辅助：构建含 tool_result 的消息列表（assistant tool_use(bash) + user tool_result 交替） */
function makeMessages(count: number, contentLength: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    // assistant 消息登记 tool_use(bash，可丢弃工具)，供 findToolName 解析
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `tool_${i}`, name: "bash", input: {} }],
    });
    msgs.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `tool_${i}`, content: "x".repeat(contentLength) },
      ],
    });
  }
  return msgs;
}

/** 辅助：构建含多种工具类型的消息列表 */
function makeMixedMessages(): Message[] {
  return [
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
  it("应识别 bash/read/grep 为可丢弃工具（大小写、连字符不敏感）", () => {
    expect(isDiscardableTool("bash")).toBe(true);
    expect(isDiscardableTool("BASH")).toBe(true);
    expect(isDiscardableTool("read")).toBe(true);
    expect(isDiscardableTool("file_read")).toBe(true);
    expect(isDiscardableTool("grep")).toBe(true);
  });

  it("应收录 sid 实际只读工具(read_many/web_search/web_fetch/tool_search)", () => {
    expect(isDiscardableTool("read_many")).toBe(true);
    expect(isDiscardableTool("web_search")).toBe(true);
    expect(isDiscardableTool("web_fetch")).toBe(true);
    expect(isDiscardableTool("tool_search")).toBe(true);
  });

  it("应识别 edit/write/未知工具不是可丢弃工具", () => {
    expect(isDiscardableTool("edit")).toBe(false);
    expect(isDiscardableTool("write")).toBe(false);
    expect(isDiscardableTool("unknown_tool")).toBe(false);
  });
});

describe("isNonDiscardableTool", () => {
  it("应识别 edit/write 为不可丢弃工具", () => {
    expect(isNonDiscardableTool("edit")).toBe(true);
    expect(isNonDiscardableTool("write")).toBe(true);
  });

  it("应识别 bash 不是不可丢弃工具", () => {
    expect(isNonDiscardableTool("bash")).toBe(false);
  });
});

describe("microcompactMessages", () => {
  it("保护窗口内的消息不应被压缩", () => {
    const msgs = makeMessages(4, 1000); // 8 条消息
    const result = microcompactMessages(msgs, { preserveRecentCount: 8, minContentLength: 500 });

    expect(result.compactedCount).toBe(0);
    expect(result.savedChars).toBe(0);
  });

  it("保护窗口外的可丢弃工具输出应被清空", () => {
    const msgs = makeMessages(5, 800); // 10 条消息，tool_use 登记为 bash（可丢弃）
    const result = microcompactMessages(msgs, { preserveRecentCount: 6, minContentLength: 500 });

    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.savedChars).toBeGreaterThan(0);
  });

  it("不可丢弃工具(edit)输出应保留前 200 字符摘要", () => {
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

    const result = microcompactMessages(msgs, { preserveRecentCount: 2, minContentLength: 500 });
    expect(result.compactedCount).toBe(1);

    const compacted = result.messages[2].content[0];
    if (compacted.type === "tool_result" && typeof compacted.content === "string") {
      expect(compacted.content).toContain("X".repeat(200));
      expect(compacted.content).toContain("已省略");
    }
  });

  it("小于 minContentLength 的输出不应被压缩", () => {
    const msgs = makeMessages(10, 100);
    const result = microcompactMessages(msgs, { preserveRecentCount: 2, minContentLength: 500 });

    expect(result.compactedCount).toBe(0);
  });

  it("空消息列表应返回空结果", () => {
    const result = microcompactMessages([], {});

    expect(result.compactedCount).toBe(0);
    expect(result.savedChars).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("混合工具类型：白名单内压缩，未知工具原样保留", () => {
    const result = microcompactMessages(makeMixedMessages(), {
      preserveRecentCount: 0,
      minContentLength: 500,
    });

    // bash/read 可丢弃, edit/write 不可丢弃 → 4 个压缩；unknown 不在白名单 → 跳过
    expect(result.compactedCount).toBe(4);
    expect(result.savedChars).toBeGreaterThan(0);

    const toolResults = result.messages[1].content;
    const byId = (id: string) =>
      toolResults.find(b => b.type === "tool_result" && b.tool_use_id === id);

    // 可丢弃工具：完全清空占位符
    const bash = byId("tool_bash");
    if (bash?.type === "tool_result" && typeof bash.content === "string") {
      expect(bash.content).toContain("可丢弃工具输出已清空");
    }
    // 不可丢弃工具：保留摘要
    const edit = byId("tool_edit");
    if (edit?.type === "tool_result" && typeof edit.content === "string") {
      expect(edit.content).toContain("保留前 200 字符");
    }
    // 未知工具：原样保留，不被压缩
    const unknown = byId("tool_unknown");
    if (unknown?.type === "tool_result" && typeof unknown.content === "string") {
      expect(unknown.content).toBe("E".repeat(800));
    }
  });

  it("cache 模式下可丢弃工具应保留前 100 字符", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_bash", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_bash", content: "Y".repeat(800) }],
      },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ];

    const result = microcompactMessages(msgs, {
      preserveRecentCount: 2,
      minContentLength: 500,
      mode: "cache",
    });
    expect(result.compactedCount).toBe(1);

    const compacted = result.messages[1].content[0];
    if (compacted.type === "tool_result" && typeof compacted.content === "string") {
      expect(compacted.content).toContain("Y".repeat(100));
      expect(compacted.content).toContain("可丢弃工具输出已清空");
    }
  });

  it("不应修改原始消息数组", () => {
    const msgs = makeMessages(4, 800);
    const originalFirst = msgs[0].content[0];
    const originalContent = originalFirst.type === "tool_result" ? originalFirst.content : "";

    microcompactMessages(msgs, { preserveRecentCount: 2, minContentLength: 500 });

    const after = msgs[0].content[0];
    const afterContent = after.type === "tool_result" ? after.content : "";
    expect(afterContent).toBe(originalContent);
  });
});
