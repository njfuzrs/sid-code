/**
 * 记忆系统提示词注入测试（Task 7）
 */

import { describe, test, expect } from "bun:test";
import { buildMemoryInstructions, buildMemorySystemPrompt } from "../../src/memory/prompt.ts";
import {
  generateRecalledMemoryAttachment,
  generateSessionMemoryAttachment,
  PRIORITY,
} from "../../src/config/attachments.ts";
import { buildSystemPrompt } from "../../src/config/system-prompt.ts";

describe("buildMemoryInstructions", () => {
  test("包含 4 类分类法", () => {
    const instr = buildMemoryInstructions();
    expect(instr).toContain("user");
    expect(instr).toContain("feedback");
    expect(instr).toContain("project");
    expect(instr).toContain("reference");
  });

  test("包含敏感信息排除规则", () => {
    const instr = buildMemoryInstructions();
    expect(instr).toContain("API Key");
  });
});

describe("buildMemorySystemPrompt", () => {
  test("无索引时只有指令", () => {
    const prompt = buildMemorySystemPrompt(null);
    expect(prompt).toContain("记忆系统");
    expect(prompt).not.toContain("MEMORY.md");
  });

  test("有索引时附加索引内容", () => {
    const index = "# Memory Index\n- [coding_style](feedback_coding-style.md) — 用 4 空格";
    const prompt = buildMemorySystemPrompt(index);
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).toContain("coding_style");
  });
});

describe("generateRecalledMemoryAttachment", () => {
  test("空数组返回 null", () => {
    expect(generateRecalledMemoryAttachment([])).toBeNull();
  });

  test("生成召回附件，优先级正确", () => {
    const att = generateRecalledMemoryAttachment([
      { filename: "user_role.md", content: "后端工程师" },
    ]);
    expect(att).not.toBeNull();
    expect(att!.priority).toBe(PRIORITY.MEMORY_RECALLED);
    expect(att!.content).toContain("user_role.md");
    expect(att!.content).toContain("后端工程师");
  });
});

describe("generateSessionMemoryAttachment", () => {
  test("空内容返回 null", () => {
    expect(generateSessionMemoryAttachment(null)).toBeNull();
    expect(generateSessionMemoryAttachment("   ")).toBeNull();
  });

  test("生成会话笔记附件", () => {
    const att = generateSessionMemoryAttachment("# Current State\n进行中");
    expect(att).not.toBeNull();
    expect(att!.priority).toBe(PRIORITY.SESSION_MEMORY);
    expect(att!.content).toContain("session-memory");
  });
});

describe("buildSystemPrompt — 记忆注入集成", () => {
  test("memorySystemPrompt 被注入核心部分", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      memorySystemPrompt: "## 记忆系统\n4 类分类法说明",
    });
    expect(prompt).toContain("记忆系统");
    expect(prompt).toContain("4 类分类法说明");
  });

  test("recalledMemories 被注入", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      recalledMemories: [{ filename: "user_role.md", content: "后端工程师，Go 专家" }],
    });
    expect(prompt).toContain("后端工程师，Go 专家");
    expect(prompt).toContain("recalled-memory");
  });

  test("sessionMemoryContent 被注入", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      sessionMemoryContent: "# Worklog\n- 完成 Task 7",
    });
    expect(prompt).toContain("完成 Task 7");
    expect(prompt).toContain("session-memory");
  });

  test("无记忆字段时不注入记忆内容", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).not.toContain("recalled-memory");
    expect(prompt).not.toContain("session-memory");
  });
});
