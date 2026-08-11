/**
 * 子代理工具过滤 — MCP 只读子代理放行收紧测试
 *
 * 锁定：explore/plan/verify（readOnly:true）的 MCP 工具不再无条件放行，
 * 必须受 Layer 2 白名单约束或经 Layer 3 逃生舱显式声明。
 * task/general-purpose 保持 MCP 放行。
 *
 * 背景：2026-07-30 轨迹 20260730-135709 实测事故——explore 子代理在只读任务里
 * 调用了 playwright/chrome-devtools，因为 tool-filter.ts 的 isMcp 无条件豁免白名单。
 * 多 provider 立场不能依赖模型遵从只读约束，必须在过滤层硬裁。
 */

import { describe, test, expect } from "bun:test";
import { filterToolsForAgent } from "@sid-code/core/agent/tool-filter.ts";
import type { LegacyTool as Tool } from "@sid-code/core/tool/types.ts";

/** 构造 mock 工具 */
function mockTool(name: string): Tool {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as Tool;
}

/** 一组覆盖内置 + MCP 的模拟工具池 */
function makeToolPool(): Tool[] {
  return [
    mockTool("read"),
    mockTool("grep"),
    mockTool("glob"),
    mockTool("ls"),
    mockTool("read_many"),
    mockTool("bash"),
    mockTool("write"),
    mockTool("edit"),
    mockTool("todo_write"),
    mockTool("mcp__playwright__browser_navigate"),
    mockTool("mcp__playwright__browser_evaluate"),
    mockTool("mcp__playwright__browser_run_code_unsafe"),
    mockTool("mcp__chrome-devtools__evaluate_script"),
    mockTool("mcp__chrome-devtools__take_screenshot"),
    mockTool("mcp__tavily__tavily_search"),
    mockTool("mcp__master-mcp__mcp_getDsl"),
    mockTool("mcp__lark-mcp__docx_builtin_search"),
    mockTool("mcp__vibe-coding__vibe_search_project_context"),
  ];
}

function names(tools: Tool[]): string[] {
  return tools.map(t => t.name());
}

describe("tool-filter MCP 只读子代理放行收紧", () => {
  const pool = makeToolPool();

  test("explore 子代理工具列表不含任何 mcp__ 工具", () => {
    const result = filterToolsForAgent(pool, {
      isBuiltIn: true,
      builtInType: "explore",
    });
    const mcpTools = names(result).filter(n => n.startsWith("mcp__"));
    expect(mcpTools).toEqual([]);
    // 内置只读工具应保留
    expect(names(result)).toContain("read");
    expect(names(result)).toContain("grep");
    expect(names(result)).toContain("glob");
  });

  test("plan 子代理工具列表不含任何 mcp__ 工具", () => {
    const result = filterToolsForAgent(pool, {
      isBuiltIn: true,
      builtInType: "plan",
    });
    const mcpTools = names(result).filter(n => n.startsWith("mcp__"));
    expect(mcpTools).toEqual([]);
    expect(names(result)).toContain("read");
    expect(names(result)).toContain("grep");
  });

  test("verify 子代理工具列表不含任何 mcp__ 工具", () => {
    const result = filterToolsForAgent(pool, {
      isBuiltIn: true,
      builtInType: "verify",
    });
    const mcpTools = names(result).filter(n => n.startsWith("mcp__"));
    expect(mcpTools).toEqual([]);
    // verify 白名单含 bash（只读+bash 核实）
    expect(names(result)).toContain("bash");
  });

  test("task 子代理工具列表含 mcp__ 工具（保持放行）", () => {
    const result = filterToolsForAgent(pool, {
      isBuiltIn: true,
      builtInType: "task",
    });
    const mcpTools = names(result).filter(n => n.startsWith("mcp__"));
    // task 不是只读，MCP 保持放行
    expect(mcpTools.length).toBeGreaterThan(0);
    expect(mcpTools).toContain("mcp__playwright__browser_navigate");
  });

  test("general-purpose 子代理工具列表含 mcp__ 工具（保持放行）", () => {
    const result = filterToolsForAgent(pool, {
      isBuiltIn: true,
      builtInType: "general-purpose",
    });
    const mcpTools = names(result).filter(n => n.startsWith("mcp__"));
    // general-purpose 白名单为 null，不进 Layer 2，MCP 全放行
    expect(mcpTools.length).toBeGreaterThan(0);
    expect(mcpTools).toContain("mcp__playwright__browser_navigate");
  });

  test("explore 显式声明 mcp__tavily 时放行该工具（逃生舱）", () => {
    const result = filterToolsForAgent(pool, {
      isBuiltIn: true,
      builtInType: "explore",
      tools: ["read", "grep", "glob", "ls", "read_many", "mcp__tavily__tavily_search"],
    });
    const mcpTools = names(result).filter(n => n.startsWith("mcp__"));
    // 只有显式声明的 tavily 放行，其余 MCP 裁掉
    expect(mcpTools).toEqual(["mcp__tavily__tavily_search"]);
  });

  test("自定义 agent（非内置）的 MCP 放行不受影响", () => {
    // isBuiltIn=false → 不进 Layer 2，MCP 仅受 Layer 3 显式 tools/disallowedTools 约束
    const result = filterToolsForAgent(pool, {
      isBuiltIn: false,
    });
    const mcpTools = names(result).filter(n => n.startsWith("mcp__"));
    // 自定义 agent 不进 Layer 2 白名单，MCP 全放行（原行为）
    expect(mcpTools.length).toBeGreaterThan(0);
  });
});
