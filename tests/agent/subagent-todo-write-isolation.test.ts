/**
 * P1-1：子代理禁用 todo_write（机制性隔离）回归测试
 *
 * 问题本质：TodoWriteTool 是全局单实例、无 agentId 概念。此前 general-purpose
 * （Layer 2 白名单 null 不限制）与自定义子代理（黑名单只禁 sub_agent）会拿到父级
 * 同一 TodoWriteTool 实例 → 并发写 todo 污染主会话 currentTodos。
 *
 * 修复：把 todo_write 加入 ALL_AGENT_DISALLOWED_TOOLS（Layer 1 硬禁），
 * 与 save_memory/enter_plan_mode 等主代理专属工具同列，所有子代理一律禁用。
 *
 * 主会话不经此过滤（filterToolsForAgent 仅用于子代理），行为完全不变。
 */

import { describe, test, expect } from "bun:test";
import { filterToolsForAgent } from "../../src/agent/tool-filter.ts";
import type { LegacyTool as Tool } from "../../src/tool/types.ts";

/** 极简假工具，仅需 name() 供过滤判断 */
function fakeTool(name: string): Tool {
  return {
    name: () => name,
    description: () => `fake ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
  };
}

// 含 todo_write + 子代理自身的 task_list，用于验证「禁 todo_write 但保留 task_list」。
const ALL = [
  "read", "write", "edit", "bash", "grep", "glob", "ls", "read_many",
  "web_search", "web_fetch", "task_list", "todo_write",
].map(fakeTool);

const names = (tools: Tool[]) => tools.map((t) => t.name()).sort();

describe("P1-1：子代理禁用 todo_write（Layer 1 硬禁）", () => {
  test("general-purpose（白名单 null 不限制）：仍拿不到 todo_write", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: true,
      builtInType: "general-purpose",
    }));
    expect(got).not.toContain("todo_write");
    // 子任务追踪工具 task_list 不受影响，仍在。
    expect(got).toContain("task_list");
  });

  test("自定义子代理（黑名单只禁 sub_agent）：仍拿不到 todo_write", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: false,
      disallowedTools: [],
    }));
    expect(got).not.toContain("todo_write");
    expect(got).toContain("task_list");
  });

  test("自定义子代理即使白名单显式声明 todo_write 也被 Layer 1 拦掉", () => {
    // Layer 1 硬禁优先于 Layer 3 白名单：显式 tools 列出 todo_write 也无效。
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: false,
      tools: ["todo_write", "read"],
    }));
    expect(got).not.toContain("todo_write");
  });

  test("内置四类型（explore/task/plan/verify）本就不含 todo_write，不回归", () => {
    for (const builtInType of ["explore", "task", "plan", "verify"]) {
      const got = names(filterToolsForAgent(ALL, { isBuiltIn: true, builtInType }));
      expect(got).not.toContain("todo_write");
    }
  });

  test("后台异步子代理：todo_write 也不放行", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: true,
      builtInType: "general-purpose",
      isAsync: true,
    }));
    expect(got).not.toContain("todo_write");
  });
});
