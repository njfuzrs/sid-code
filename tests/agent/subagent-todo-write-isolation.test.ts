/**
 * P1-2：子代理 todo_write 追踪隔离回归测试
 *
 * 旧行为（P1-1）：TodoWriteTool 全局单实例、无 agentId 概念，子代理复用父级实例会并发写
 * 污染主会话 currentTodos，因此把 todo_write 加入 Layer 1 硬禁，所有子代理一律禁用。
 *
 * 新行为（P1-2，对齐 CC per-agent todo 命名空间）：
 * - buildIsolatedToolRegistry 给每个进程内子代理构造**独立 TodoWriteTool 实例**（与
 *   FileReadTracker 工具同构），spawn 路径本就是独立子进程 → 污染根因消除。
 * - 因此 todo_write 从 Layer 1 硬禁移除，子代理恢复 todo 追踪能力。
 * - 各内置类型白名单显式加入 todo_write；后台异步白名单也加入。
 *
 * 主会话不经此过滤（filterToolsForAgent 仅用于子代理），行为完全不变。
 */

import { describe, test, expect } from "bun:test";
import { filterToolsForAgent } from "../../src/agent/tool-filter.ts";
import type { LegacyTool as Tool } from "../../src/tool/types.ts";
import { TodoWriteTool } from "../../src/tool/todo-write.ts";

/** 极简假工具，仅需 name() 供过滤判断 */
function fakeTool(name: string): Tool {
  return {
    name: () => name,
    description: () => `fake ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
  };
}

const ALL = [
  "read", "write", "edit", "bash", "grep", "glob", "ls", "read_many",
  "web_search", "web_fetch", "task_list", "todo_write",
].map(fakeTool);

const names = (tools: Tool[]) => tools.map((t) => t.name()).sort();

describe("P1-2：子代理恢复 todo_write（隔离实例）", () => {
  test("general-purpose（白名单 null 不限制）：拿得到 todo_write", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: true,
      builtInType: "general-purpose",
    }));
    expect(got).toContain("todo_write");
    expect(got).toContain("task_list");
  });

  test("自定义子代理（黑名单只禁 sub_agent）：拿得到 todo_write", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: false,
      disallowedTools: [],
    }));
    expect(got).toContain("todo_write");
  });

  test("内置四类型（explore/task/plan/verify）白名单均含 todo_write", () => {
    for (const builtInType of ["explore", "task", "plan", "verify"]) {
      const got = names(filterToolsForAgent(ALL, { isBuiltIn: true, builtInType }));
      expect(got).toContain("todo_write");
    }
  });

  test("后台异步子代理：todo_write 也放行", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: true,
      builtInType: "general-purpose",
      isAsync: true,
    }));
    expect(got).toContain("todo_write");
  });

  test("自定义子代理黑名单显式禁 todo_write 仍生效（Layer 3 可裁剪）", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: false,
      disallowedTools: ["todo_write"],
    }));
    expect(got).not.toContain("todo_write");
  });
});

describe("P1-2：独立 TodoWriteTool 实例互不污染", () => {
  test("两个实例的 currentTodos 各自独立，写一个不影响另一个", async () => {
    // 模拟主会话与子代理各持一份独立实例（buildIsolatedToolRegistry 的效果）
    const mainTool = new TodoWriteTool();
    const subTool = new TodoWriteTool();

    await mainTool.execute({
      todos: [
        { content: "主任务", activeForm: "正在做主任务", status: "in_progress" },
      ],
    });
    await subTool.execute({
      todos: [
        { content: "子任务A", activeForm: "正在做子任务A", status: "completed" },
        { content: "子任务B", activeForm: "正在做子任务B", status: "in_progress" },
      ],
    });

    // 主会话清单不被子代理写入污染
    expect(mainTool.getTodos()).toHaveLength(1);
    expect(mainTool.getTodos()[0].content).toBe("主任务");

    // 子代理清单独立保存
    expect(subTool.getTodos()).toHaveLength(2);
    expect(subTool.getTodos()[1].content).toBe("子任务B");
  });
});
