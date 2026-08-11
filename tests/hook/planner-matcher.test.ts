/**
 * Hook matcher 精确匹配测试（G8：对齐 CC utils/hooks.ts matchesPattern 三档语义）
 *
 * 核心回归：`matcher:"Edit"` 只命中 `Edit`，不再误命中 `NotebookEdit`/`MultiEdit`（旧 regex-first bug）。
 * 通过公开 API createExecutionPlan 间接验证 private matchesToolName。
 */

import { describe, test, expect } from "bun:test";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookPlanner } from "@sid-code/core/hook/planner.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";

/** 辅助：注册一个 PreToolUse hook（带 matcher），返回 planner */
function makePlanner(matcher: string): HookPlanner {
  const registry = new HookRegistry();
  registry.registerHook(
    { type: "command", command: "echo hit" },
    HookEventName.PreToolUse,
    { matcher },
  );
  return new HookPlanner(registry);
}

/** 辅助：判断某工具名是否命中 matcher */
function matches(matcher: string, toolName: string): boolean {
  const planner = makePlanner(matcher);
  const plan = planner.createExecutionPlan(HookEventName.PreToolUse, { toolName });
  return plan !== null && plan.hookConfigs.length > 0;
}

describe("Hook matcher 三档语义（G8）", () => {
  // === 第 2 档：纯字母数字下划线 → 精确匹配 ===

  test("Edit 精确匹配，不误命中 NotebookEdit/MultiEdit", () => {
    expect(matches("Edit", "Edit")).toBe(true);
    expect(matches("Edit", "NotebookEdit")).toBe(false);
    expect(matches("Edit", "MultiEdit")).toBe(false);
  });

  test("Bash 精确匹配", () => {
    expect(matches("Bash", "Bash")).toBe(true);
    expect(matches("Bash", "bash")).toBe(false); // 大小写敏感
    expect(matches("Bash", "BashOutput")).toBe(false);
  });

  test("管道分隔 Write|Edit 命中两者但不命中 Rewrite", () => {
    expect(matches("Write|Edit", "Write")).toBe(true);
    expect(matches("Write|Edit", "Edit")).toBe(true);
    expect(matches("Write|Edit", "Rewrite")).toBe(false);
    expect(matches("Write|Edit", "MultiEdit")).toBe(false);
  });

  test("下划线工具名精确匹配（如 tool_search）", () => {
    expect(matches("tool_search", "tool_search")).toBe(true);
    expect(matches("tool_search", "tool_search_v2")).toBe(false);
  });

  // === 第 3 档：含正则元字符 → 当正则 ===

  test("Notebook.* 走正则命中 NotebookEdit/NotebookRead", () => {
    expect(matches("Notebook.*", "NotebookEdit")).toBe(true);
    expect(matches("Notebook.*", "NotebookRead")).toBe(true);
    expect(matches("Notebook.*", "Edit")).toBe(false);
  });

  test("mcp__.* 正则匹配 MCP 工具", () => {
    expect(matches("mcp__.*", "mcp__server__tool")).toBe(true);
    expect(matches("mcp__.*", "mcp__playwright__click")).toBe(true);
    expect(matches("mcp__.*", "bash")).toBe(false);
  });

  test("显式 /pattern/ 包裹强制正则", () => {
    expect(matches("/^Edit$/", "Edit")).toBe(true);
    expect(matches("/Edit/", "NotebookEdit")).toBe(true); // /Edit/ 未锚定，子串匹配
  });

  test("非法正则返回 false（不抛异常）", () => {
    // "[" 是非法正则；但它含正则元字符，走第 3 档 → catch → false
    expect(matches("[", "anything")).toBe(false);
    expect(matches("/[/", "anything")).toBe(false);
  });

  // === 第 1 档：通配符 ===

  test("* 命中全部", () => {
    expect(matches("*", "Edit")).toBe(true);
    expect(matches("*", "bash")).toBe(true);
    expect(matches("*", "mcp__x__y")).toBe(true);
  });

  test("空 matcher 命中全部", () => {
    expect(matches("", "Edit")).toBe(true);
  });
});
