/**
 * 系统提示词构建测试
 */

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/config/system-prompt.ts";
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
    expect(prompt).toContain("<project-rules>");
    expect(prompt).toContain("使用 TypeScript");
    expect(prompt).toContain("</project-rules>");
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
});
