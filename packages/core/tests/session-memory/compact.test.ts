/**
 * Session Memory 压缩集成测试（Task 5）
 */

import { describe, test, expect } from "bun:test";
import {
  trySessionMemoryCompaction,
  type SessionMemoryProvider,
} from "@sid-code/core/session-memory/compact.ts";
import { DEFAULT_SESSION_MEMORY_TEMPLATE } from "@sid-code/core/session-memory/prompts.ts";

describe("trySessionMemoryCompaction", () => {
  test("Session Memory 为空 → 返回 null（回退传统压缩）", async () => {
    const provider: SessionMemoryProvider = {
      getContent: async () => DEFAULT_SESSION_MEMORY_TEMPLATE, // 只有模板，无实际内容
      waitForExtraction: async () => {},
    };
    const result = await trySessionMemoryCompaction(provider);
    expect(result).toBeNull();
  });

  test("getContent 返回 null → 返回 null", async () => {
    const provider: SessionMemoryProvider = {
      getContent: async () => null,
      waitForExtraction: async () => {},
    };
    const result = await trySessionMemoryCompaction(provider);
    expect(result).toBeNull();
  });

  test("有实际内容 → 返回结构化摘要", async () => {
    const filled = `# Current State\n正在实现 Task 5 压缩集成\n\n# Worklog\n- 完成 compact.ts\n- 编写测试`;
    const provider: SessionMemoryProvider = {
      getContent: async () => filled,
      waitForExtraction: async () => {},
    };
    const result = await trySessionMemoryCompaction(provider);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("session-memory");
    expect(result!.summary).toContain("Task 5");
    expect(result!.summary).toContain("Session Memory");
  });

  test("会等待进行中的提取", async () => {
    let waited = false;
    const provider: SessionMemoryProvider = {
      getContent: async () => `# Current State\n有内容`,
      waitForExtraction: async () => {
        waited = true;
      },
    };
    await trySessionMemoryCompaction(provider);
    expect(waited).toBe(true);
  });

  test("getContent 抛错 → 优雅返回 null", async () => {
    const provider: SessionMemoryProvider = {
      getContent: async () => {
        throw new Error("读取失败");
      },
      waitForExtraction: async () => {},
    };
    const result = await trySessionMemoryCompaction(provider);
    expect(result).toBeNull();
  });
});
