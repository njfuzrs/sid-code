/**
 * 子代理工具过滤 Layer 4（异步白名单）回归测试
 *
 * 对照 claude-code 排查发现的缺口 B：tool-filter.ts 设计了 Layer 4
 * （ASYNC_ALLOWED_TOOLS，后台 Agent 只允许安全子集），但 sub-agent.ts 两处
 * filterToolsForAgent 调用从不传 isAsync，导致后台执行（run_in_background）时
 * 该层是死代码。影响面：内置 explore/task/plan/verify 因 Layer 2 白名单已 ≤
 * 异步子集无实害；但 general-purpose（Layer 2=null 不限制）与自定义 agent
 * 在后台跑时会拿到超出异步安全子集的工具。
 *
 * 修复：SubAgentTask 加 _isAsync 标记，executeInBackground 传 true，
 * 两处 filterToolsForAgent 透传 isAsync，让 Layer 4 真正生效。
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

// enter_plan_mode/sub_agent 等被 Layer 1 硬禁；其余为可能被 Layer 4 收敛的工具。
const ALL = [
  "read", "write", "edit", "bash", "grep", "glob", "ls", "read_many",
  "web_search", "web_fetch", "task_list",
  "some_unsafe_tool", // 不在任何白名单 → 异步时应被 Layer 4 拦掉
].map(fakeTool);

const names = (tools: Tool[]) => tools.map((t) => t.name()).sort();

describe("filterToolsForAgent Layer 4 异步白名单（缺口 B）", () => {
  test("general-purpose 同步：Layer 2=null 不限制，超集工具放行", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: true,
      builtInType: "general-purpose",
      isAsync: false,
    }));
    // 同步下不套 Layer 4，some_unsafe_tool 仍在
    expect(got).toContain("some_unsafe_tool");
  });

  test("general-purpose 后台（isAsync=true）：Layer 4 收敛到安全子集", () => {
    const got = names(filterToolsForAgent(ALL, {
      isBuiltIn: true,
      builtInType: "general-purpose",
      isAsync: true,
    }));
    // 不在 ASYNC_ALLOWED_TOOLS 的工具被拦掉
    expect(got).not.toContain("some_unsafe_tool");
    // 安全子集工具仍在
    expect(got).toContain("read");
    expect(got).toContain("bash");
  });

  test("isAsync 切换确实改变结果（修复前后对照）", () => {
    const sync = names(filterToolsForAgent(ALL, {
      isBuiltIn: true, builtInType: "general-purpose", isAsync: false,
    }));
    const async = names(filterToolsForAgent(ALL, {
      isBuiltIn: true, builtInType: "general-purpose", isAsync: true,
    }));
    // 异步集合应是同步集合的真子集（Layer 4 只会收紧，不会放宽）
    expect(async.length).toBeLessThan(sync.length);
    expect(async.every((n) => sync.includes(n))).toBe(true);
  });

  test("MCP 工具不受 Layer 4 影响（用户显式配置，始终通过）", () => {
    const withMcp = [...ALL, fakeTool("mcp__server__do")];
    const got = names(filterToolsForAgent(withMcp, {
      isBuiltIn: true, builtInType: "general-purpose", isAsync: true,
    }));
    expect(got).toContain("mcp__server__do");
  });

  test("内置 task 类型：Layer 2 白名单已 ≤ 异步子集，加 isAsync 无回退", () => {
    const sync = names(filterToolsForAgent(ALL, {
      isBuiltIn: true, builtInType: "task", isAsync: false,
    }));
    const async = names(filterToolsForAgent(ALL, {
      isBuiltIn: true, builtInType: "task", isAsync: true,
    }));
    // task 的 Layer 2 白名单内工具都在 ASYNC 白名单内 → 加 isAsync 结果不变
    expect(async).toEqual(sync);
    expect(async).not.toContain("some_unsafe_tool"); // Layer 2 已挡掉
  });
});
