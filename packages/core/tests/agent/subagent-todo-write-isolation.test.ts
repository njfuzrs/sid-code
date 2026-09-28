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
 *
 * ⚠️ P1-3 修正（本文件曾经绿着，而生产是坏的）：
 * 原先这里有一条「内置四类型白名单均含 todo_write」，它**不传 `tools`**，
 * 于是只测到了 Layer 2 白名单，Layer 3（agent 定义的 `tools` 字段）整层没进判定。
 * 生产路径（`resolveAgentTools`）一定会把定义的 `tools` 传进来，而那四个定义都不含
 * todo_write —— 两层是交集，结果四类全被裁掉。所以那条断言测的是一个生产中
 * **不存在**的组合：白名单里那行 todo_write 是死的，测试却为它背书。
 *
 * 现在的口径（单一事实源，两侧成对声明）：
 * - 会写代码的类型（task / general-purpose）**拿得到** todo_write；
 * - 只读类型（explore / plan / verify）**拿不到**（产出是报告，不是带状态的清单）。
 * 断言一律走 `BUILTIN_AGENTS[type].tools`，即生产实际传进来的那一份。
 *
 * 主会话不经此过滤（filterToolsForAgent 仅用于子代理），行为完全不变。
 */

import { describe, test, expect } from "bun:test";
import { filterToolsForAgent } from "@sid-code/core/agent/tool-filter.ts";
import { BUILTIN_AGENTS } from "@sid-code/core/agent/agent-definition.ts";
import type { LegacyTool as Tool } from "@sid-code/core/tool/types.ts";
import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";

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
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "ls",
  "read_many",
  "web_search",
  "web_fetch",
  "task_list",
  "todo_write",
].map(fakeTool);

const names = (tools: Tool[]) => tools.map((t) => t.name()).sort();

describe("P1-2：子代理恢复 todo_write（隔离实例）", () => {
  test("general-purpose（白名单 null 不限制）：拿得到 todo_write", () => {
    const got = names(
      filterToolsForAgent(ALL, {
        isBuiltIn: true,
        builtInType: "general-purpose",
      }),
    );
    expect(got).toContain("todo_write");
    expect(got).toContain("task_list");
  });

  test("自定义子代理（黑名单只禁 sub_agent）：拿得到 todo_write", () => {
    const got = names(
      filterToolsForAgent(ALL, {
        isBuiltIn: false,
        disallowedTools: [],
      }),
    );
    expect(got).toContain("todo_write");
  });

  // ---- P1-3：按生产实际的两层交集断言（必须传 tools，否则 Layer 3 不进判定）----
  //
  // 这是本文件的关键反漂移点：只测白名单会得到一个「生产中不存在的组合」。
  // 下面两条一起把口径钉死——改任何一侧（白名单或定义的 tools），必有一条变红。
  const filterAsProduction = (builtInType: string) => {
    const def = BUILTIN_AGENTS[builtInType];
    return names(
      filterToolsForAgent(ALL, {
        isBuiltIn: true,
        builtInType,
        // 生产路径 resolveAgentTools 一定会传这两个字段
        tools: def?.tools,
        disallowedTools: def?.disallowedTools,
      }),
    );
  };

  test("P1-3：会写代码的类型（task）在两层交集下真能拿到 todo_write", () => {
    expect(filterAsProduction("task")).toContain("todo_write");
  });

  test("P1-3：只读类型（explore/plan/verify）拿不到 todo_write（口径：产出是报告）", () => {
    for (const builtInType of ["explore", "plan", "verify"]) {
      expect(filterAsProduction(builtInType)).not.toContain("todo_write");
    }
  });

  test("P1-3：白名单与定义 tools 必须成对声明（任一侧漏掉都算漂移）", () => {
    // 事实源纪律的机械断言：凡是定义层 tools 显式列了 todo_write 的内置类型，
    // 走完整过滤后必须真拿到它——否则就是「定义说可以、白名单裁掉了」的反向漂移。
    for (const [type, def] of Object.entries(BUILTIN_AGENTS)) {
      const declared = def.tools?.includes("todo_write") === true;
      if (declared) {
        expect(filterAsProduction(type)).toContain("todo_write");
      }
    }
  });

  test("后台异步子代理：todo_write 也放行", () => {
    const got = names(
      filterToolsForAgent(ALL, {
        isBuiltIn: true,
        builtInType: "general-purpose",
        isAsync: true,
      }),
    );
    expect(got).toContain("todo_write");
  });

  test("自定义子代理黑名单显式禁 todo_write 仍生效（Layer 3 可裁剪）", () => {
    const got = names(
      filterToolsForAgent(ALL, {
        isBuiltIn: false,
        disallowedTools: ["todo_write"],
      }),
    );
    expect(got).not.toContain("todo_write");
  });
});

describe("P1-2：独立 TodoWriteTool 实例互不污染", () => {
  test("两个实例的 currentTodos 各自独立，写一个不影响另一个", async () => {
    // 模拟主会话与子代理各持一份独立实例（buildIsolatedToolRegistry 的效果）
    const mainTool = new TodoWriteTool();
    const subTool = new TodoWriteTool();

    await mainTool.execute({
      todos: [{ content: "主任务", active_form: "正在做主任务", status: "in_progress" }],
    });
    await subTool.execute({
      todos: [
        { content: "子任务A", active_form: "正在做子任务A", status: "completed" },
        { content: "子任务B", active_form: "正在做子任务B", status: "in_progress" },
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
