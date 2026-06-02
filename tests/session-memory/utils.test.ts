/**
 * Session Memory 工具函数测试（Task 4 / Task 5）
 */

import { describe, test, expect } from "bun:test";
import type { Message } from "../../src/llm/types.ts";
import {
  estimateMessagesTokens,
  hasToolCallsInLastAssistantTurn,
  shouldExtractSessionMemory,
  splitSessionMemorySections,
  isSessionMemoryEmpty,
  truncateSessionMemory,
  initialSessionMemoryState,
} from "../../src/session-memory/utils.ts";
import { DEFAULT_SESSION_MEMORY_TEMPLATE } from "../../src/session-memory/prompts.ts";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantWithTool(): Message {
  return { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] };
}
function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("estimateMessagesTokens", () => {
  test("统计文本与工具块", () => {
    const tokens = estimateMessagesTokens([userMsg("hello world"), assistantText("response text")]);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("hasToolCallsInLastAssistantTurn", () => {
  test("最后一轮有工具调用", () => {
    expect(hasToolCallsInLastAssistantTurn([userMsg("q"), assistantWithTool()])).toBe(true);
  });
  test("最后一轮纯文本", () => {
    expect(hasToolCallsInLastAssistantTurn([userMsg("q"), assistantText("done")])).toBe(false);
  });
});

describe("shouldExtractSessionMemory — 双阈值", () => {
  const config = { minimumMessageTokensToInit: 100, minimumTokensBetweenUpdate: 50, toolCallsBetweenUpdates: 3 };

  test("未初始化 + token 不足 → 不触发", () => {
    const state = initialSessionMemoryState();
    const messages = [userMsg("short")];
    expect(shouldExtractSessionMemory(state, messages, config)).toBe(false);
  });

  test("提取进行中 → 不触发", () => {
    const state = { ...initialSessionMemoryState(), extractionInProgress: true };
    const big = "x".repeat(2000);
    expect(shouldExtractSessionMemory(state, [userMsg(big)], config)).toBe(false);
  });

  test("token 足够 + 最后一轮无工具 → 触发（自然断点）", () => {
    const state = initialSessionMemoryState();
    const big = "x".repeat(2000);
    const messages = [userMsg(big), assistantText("done")];
    expect(shouldExtractSessionMemory(state, messages, config)).toBe(true);
  });

  test("token 足够 + 工具调用达标 → 触发", () => {
    const state = { ...initialSessionMemoryState(), toolCallsSinceLastUpdate: 3 };
    const big = "x".repeat(2000);
    const messages = [userMsg(big), assistantWithTool()];
    expect(shouldExtractSessionMemory(state, messages, config)).toBe(true);
  });

  test("token 增长不足 → 不触发", () => {
    const big = "x".repeat(2000);
    const messages = [userMsg(big), assistantText("done")];
    const currentTokens = estimateMessagesTokens(messages);
    const state = { ...initialSessionMemoryState(), initialized: true, lastSummarizedTokenCount: currentTokens };
    expect(shouldExtractSessionMemory(state, messages, config)).toBe(false);
  });
});

describe("splitSessionMemorySections", () => {
  test("按 # 标题分段", () => {
    const sections = splitSessionMemorySections(DEFAULT_SESSION_MEMORY_TEMPLATE);
    const titles = sections.map((s) => s.title);
    expect(titles).toContain("Session Title");
    expect(titles).toContain("Current State");
    expect(titles).toContain("Worklog");
  });
});

describe("isSessionMemoryEmpty", () => {
  test("模板（只有占位描述）视为空", () => {
    expect(isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(true);
  });
  test("null / 空串视为空", () => {
    expect(isSessionMemoryEmpty(null)).toBe(true);
    expect(isSessionMemoryEmpty("   ")).toBe(true);
  });
  test("有实际内容不为空", () => {
    const filled = `# Current State\n正在实现记忆系统的 Task 5\n\n# Worklog\n- 完成 utils.ts`;
    expect(isSessionMemoryEmpty(filled)).toBe(false);
  });
});

describe("truncateSessionMemory", () => {
  test("保留 section 结构", () => {
    const content = `# A\n内容A\n\n# B\n内容B`;
    const out = truncateSessionMemory(content, 12000, 2000);
    expect(out).toContain("# A");
    expect(out).toContain("# B");
  });

  test("超长 section 被按行截断", () => {
    const longBody = Array.from({ length: 500 }, (_, i) => `line ${i} 内容内容内容`).join("\n");
    const content = `# Big\n${longBody}`;
    const out = truncateSessionMemory(content, 12000, 200);
    expect(out).toContain("# Big");
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(content.length);
  });
});
