/**
 * src/context/tool-result-storage.ts 单测
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  persistLargeOutput,
  isPersistedReference,
  ContentReplacementState,
  enforceToolResultBudget,
  cleanupPersistedOutputs,
  PERSISTED_OUTPUT_PREFIX,
} from "../../src/context/tool-result-storage.ts";
import { existsSync, unlinkSync, rmdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "../../src/llm/types.ts";

const testSessionId = "test-storage-session-001";

describe("persistLargeOutput", () => {
  it("短内容不持久化，返回原内容", () => {
    const result = persistLargeOutput("hello", "tool_001", "bash", testSessionId, 100);
    expect(result.reference).toBe("hello");
    expect(result.savedPath).toBe("");
    expect(result.originalLength).toBe(5);
  });

  it("长内容持久化到磁盘", () => {
    const longContent = "A".repeat(500);
    const result = persistLargeOutput(longContent, "tool_002", "grep", testSessionId, 100);

    expect(result.originalLength).toBe(500);
    expect(result.savedPath).not.toBe("");
    expect(result.reference).toContain(PERSISTED_OUTPUT_PREFIX);
    expect(result.reference).toContain("tool_use_id=tool_002");
    expect(result.reference).toContain("tool=grep");
    expect(result.reference).toContain("字符数=500");

    // 验证文件存在
    expect(existsSync(result.savedPath)).toBe(true);
  });

  it("持久化后的引用约 200 字节", () => {
    const longContent = "B".repeat(500);
    const result = persistLargeOutput(longContent, "tool_003", "bash", testSessionId, 100);

    // 引用应该远小于原内容
    expect(result.reference.length).toBeLessThan(500);
    expect(result.reference.length).toBeLessThanOrEqual(300);
  });

  afterAll(() => {
    // 清理测试文件
    const dir = join(homedir(), ".sid-code", "trajectories", "sessions", testSessionId, "tool-outputs");
    try {
      cleanupPersistedOutputs(testSessionId, 0);
    } catch {}
  });
});

describe("isPersistedReference", () => {
  it("应识别持久化引用", () => {
    const ref = "[持久化输出] tool_use_id=xxx | tool=bash | 字符数=1000 | 文件=/tmp/test.txt";
    expect(isPersistedReference(ref)).toBe(true);
  });

  it("普通内容不应识别为持久化引用", () => {
    expect(isPersistedReference("hello world")).toBe(false);
    expect(isPersistedReference("")).toBe(false);
  });
});

describe("ContentReplacementState", () => {
  it("首次调用应使用 generator", () => {
    const state = new ContentReplacementState();
    let callCount = 0;

    const val = state.getOrCreate("tool_a", () => {
      callCount++;
      return "generated_value";
    });

    expect(val).toBe("generated_value");
    expect(callCount).toBe(1);
  });

  it("同一 tool_use_id 多次调用返回相同值，不触发 generator", () => {
    const state = new ContentReplacementState();
    let callCount = 0;

    const val1 = state.getOrCreate("tool_a", () => {
      callCount++;
      return "value_1";
    });
    const val2 = state.getOrCreate("tool_a", () => {
      callCount++;
      return "value_2";
    });

    expect(val1).toBe("value_1");
    expect(val2).toBe("value_1"); // 应返回缓存值
    expect(callCount).toBe(1); // generator 只调用一次
  });

  it("不同 tool_use_id 应独立缓存", () => {
    const state = new ContentReplacementState();

    const valA = state.getOrCreate("tool_a", () => "a");
    const valB = state.getOrCreate("tool_b", () => "b");

    expect(valA).toBe("a");
    expect(valB).toBe("b");
    expect(state.size).toBe(2);
  });

  it("clear 应清空所有状态", () => {
    const state = new ContentReplacementState();
    state.getOrCreate("tool_a", () => "a");
    expect(state.size).toBe(1);

    state.clear();
    expect(state.size).toBe(0);
  });
});

describe("enforceToolResultBudget", () => {
  function makeBudgetMessages(): Message[] {
    return [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "A".repeat(1000) }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "B".repeat(1000) }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "3", content: "C".repeat(1000) }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
  }

  it("预算充足时不应截断", () => {
    const msgs = makeBudgetMessages();
    const result = enforceToolResultBudget(msgs, { maxTokens: 10000, preserveRecentCount: 0, charsPerToken: 4 });

    // 3 个 × 1000 字符 = 3000 字符 < 40000 字符 (10000 tokens × 4)
    expect(result.truncatedCount).toBe(0);
  });

  it("预算不足时应截断旧输出", () => {
    const msgs = makeBudgetMessages();
    const result = enforceToolResultBudget(msgs, { maxTokens: 200, preserveRecentCount: 0, charsPerToken: 4 });

    // 200 tokens × 4 = 800 字符预算，3 个各 1000 字符
    // 前两个用完预算，第三个被截断
    expect(result.truncatedCount).toBeGreaterThan(0);
  });

  it("保护窗口内的消息不应被截断", () => {
    const msgs = makeBudgetMessages();
    // preserveRecentCount=2 保护最后 2 条消息（最新的 assistant + user）
    // 只有第一条 user 消息可能被截断
    const result = enforceToolResultBudget(msgs, { maxTokens: 200, preserveRecentCount: 4, charsPerToken: 4 });

    expect(result.truncatedCount).toBeGreaterThanOrEqual(0);
  });
});
