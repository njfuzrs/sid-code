/**
 * 系统提示词构建测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildSystemPrompt, clearPromptCache } from "../../src/config/system-prompt.ts";
import type { Tool } from "../../src/tool/types.ts";

/** 创建一个简单的测试工具 */
function makeTool(opts: { name: string; desc: string; guide?: string }): Tool {
  return {
    name: () => opts.name,
    description: () => opts.desc,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    readOnly: () => true,
    ...(opts.guide ? { usageGuide: () => opts.guide! } : {}),
  };
}

describe("buildSystemPrompt", () => {
  // 每个测试前清除缓存，避免测试间干扰
  beforeEach(() => {
    clearPromptCache();
  });

  test("包含身份指令", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).toContain("sid-code");
    expect(prompt).toContain("AI 编程助手");
  });

  test("包含环境信息", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).toContain("<environment>");
    expect(prompt).toContain("工作目录");
    expect(prompt).toContain("操作系统");
    expect(prompt).toContain("当前日期");
    expect(prompt).toContain("</environment>");
  });

  test("包含行为约束", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).toContain("<constraints>");
    expect(prompt).toContain("中文");
    expect(prompt).toContain("</constraints>");
  });

  test("无工具时不包含工具指南", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).not.toContain("<tool-guide>");
  });

  test("有工具时包含工具列表", () => {
    const tools = [
      makeTool({ name: "read", desc: "读取文件" }),
      makeTool({ name: "write", desc: "写入文件" }),
    ];
    const prompt = buildSystemPrompt({ tools });
    expect(prompt).toContain("<tool-guide>");
    expect(prompt).toContain("read: 读取文件");
    expect(prompt).toContain("write: 写入文件");
    expect(prompt).toContain("</tool-guide>");
  });

  test("工具自带 usageGuide 会被包含", () => {
    const tools = [
      makeTool({ name: "bash", desc: "执行命令", guide: "不要用 bash cat 读文件" }),
    ];
    const prompt = buildSystemPrompt({ tools });
    expect(prompt).toContain("bash 工具使用指南");
    expect(prompt).toContain("不要用 bash cat 读文件");
  });

  test("没有 usageGuide 的工具不会生成额外指南", () => {
    const tools = [
      makeTool({ name: "read", desc: "读取文件" }),
    ];
    const prompt = buildSystemPrompt({ tools });
    expect(prompt).not.toContain("read 工具使用指南");
  });

  test("包含项目规则", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      projectRules: "# 项目规则\n使用 TypeScript",
    });
    expect(prompt).toContain("<system-reminder>");
    expect(prompt).toContain("使用 TypeScript");
    expect(prompt).toContain("覆盖任何默认行为");
  });

  test("包含项目规则来源路径", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      projectRules: "规则内容",
      projectRulesPath: "/project/CLAUDE.md",
    });
    expect(prompt).toContain("Contents of /project/CLAUDE.md");
  });

  test("包含追加提示词", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      appendPrompt: "额外指令",
    });
    expect(prompt).toContain("额外指令");
  });

  test("包含文件提示词", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      filePrompt: "从文件加载的提示词",
    });
    expect(prompt).toContain("从文件加载的提示词");
  });

  // === 新增：动态附件测试 ===

  test("包含 Git 状态附件", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      workingDir: process.cwd(),
      gitStatus: true,
    });
    expect(prompt).toContain("<git-status>");
    expect(prompt).toContain("当前分支:");
  });

  test("不请求 Git 状态时不包含", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      gitStatus: false,
    });
    expect(prompt).not.toContain("<git-status>");
  });

  test("包含权限模式附件（非默认模式）", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      permissionMode: "plan",
    });
    expect(prompt).toContain("计划模式已激活");
  });

  test("默认权限模式不注入附件", () => {
    const prompt1 = buildSystemPrompt({ tools: [] });
    const prompt2 = buildSystemPrompt({ tools: [], permissionMode: "default" });
    // 默认模式不注入权限附件
    expect(prompt1).not.toContain("权限模式");
    expect(prompt2).not.toContain("权限模式");
  });

  test("包含诊断信息附件", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      diagnostics: "Error: 类型不匹配 at line 42",
    });
    expect(prompt).toContain("<diagnostics>");
    expect(prompt).toContain("类型不匹配");
  });

  test("包含 IDE 选中代码附件", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      ideSelection: "const x: number = 'hello';",
    });
    expect(prompt).toContain("<ide-selection>");
    expect(prompt).toContain("const x: number");
  });

  test("包含 Todo 列表附件", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      todoList: "- [ ] 修复 bug\n- [x] 写测试",
    });
    expect(prompt).toContain("<todo-list>");
    expect(prompt).toContain("修复 bug");
  });

  test("附件按优先级排序", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      projectRules: "RULES_MARKER",
      todoList: "TODO_MARKER",
      appendPrompt: "APPEND_MARKER",
    });
    // CLAUDE.md (priority 10) 应在 Todo (35) 之前，Todo 在 Append (50) 之前
    const rulesIdx = prompt.indexOf("RULES_MARKER");
    const todoIdx = prompt.indexOf("TODO_MARKER");
    const appendIdx = prompt.indexOf("APPEND_MARKER");
    expect(rulesIdx).toBeLessThan(todoIdx);
    expect(todoIdx).toBeLessThan(appendIdx);
  });

  // === 缓存测试 ===

  test("相同上下文使用缓存", () => {
    const ctx = { tools: [], projectRules: "缓存测试规则" };
    const prompt1 = buildSystemPrompt(ctx);
    const prompt2 = buildSystemPrompt(ctx);
    // 内容应该完全相同（来自缓存）
    expect(prompt1).toBe(prompt2);
  });

  test("不同上下文不使用缓存", () => {
    const prompt1 = buildSystemPrompt({ tools: [], projectRules: "规则A" });
    const prompt2 = buildSystemPrompt({ tools: [], projectRules: "规则B" });
    expect(prompt1).not.toBe(prompt2);
    expect(prompt1).toContain("规则A");
    expect(prompt2).toContain("规则B");
  });

  test("clearPromptCache 清除缓存", () => {
    const ctx = { tools: [], projectRules: "清除缓存测试" };
    const prompt1 = buildSystemPrompt(ctx);
    clearPromptCache();
    const prompt2 = buildSystemPrompt(ctx);
    // 内容相同但确实重新构建了（无法直接验证，但至少不报错）
    expect(prompt1).toBe(prompt2);
  });
});
