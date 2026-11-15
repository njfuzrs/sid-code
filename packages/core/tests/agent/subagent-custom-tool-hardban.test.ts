/**
 * custom 子代理的 allowedTools 分支必须过 Layer 1 硬禁（06H1 复核发现）
 *
 * 背景：`resolveCustomTools` 有两条分支。
 *   - `toolsFromAgentType` 分支走 `filterToolsForAgent`，硬禁（Layer 1）生效；
 *   - `allowedTools` 分支是「按名从 registry 直接取」，**此前没有任何过滤**。
 *
 * 后果：在自定义 agent 的 frontmatter 写 `tools: [monitor]` 就能把
 * `ALL_AGENT_DISALLOWED_TOOLS` 里的工具拿回去，而 monitor 的硬禁理由
 * （生命周期最长 30 分钟，远长于子代理；子代理一结束，它挂的监控没有事件消费者，
 * 只能空转到期限）在那条路径上完全失效。同理可拿回 task_stop / task_output /
 * enter_plan_mode / exit_plan_mode / save_memory。
 *
 * 修法：把 Layer 1 判据抽成 `isAllAgentDisallowedTool` 导出，两条路径共用。
 * 本文件守的就是「新增硬禁项时不会只堵一边」。
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import type { CustomSubAgentTask } from "@sid-code/core/agent/sub-agent.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { isAllAgentDisallowedTool } from "@sid-code/core/agent/tool-filter.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";

/** 最小可用工具桩：只提供 name 与 call，足够走 resolveCustomTools 的查表。 */
/** Registry 内部存的是 LegacyTool（name/call 都是方法），桩要按那个形状写。 */
function stubTool(name: string): any {
  return {
    name: () => name,
    description: () => `stub ${name}`,
    call: async () => ({ output: "stub" }),
    isReadOnly: () => true,
    checkPermissions: async () => ({ behavior: "passthrough" as const }),
  };
}

function makeAgent(registry: ToolRegistry): SubAgent {
  return new SubAgent({} as Provider, "test-model", registry);
}

function customTask(allowedTools: string[]): CustomSubAgentTask {
  return {
    systemPrompt: "you are a test agent",
    userPrompt: "do something",
    allowedTools,
    type: "test-custom",
  } as CustomSubAgentTask;
}

function namesOf(tools: any[]): string[] {
  return tools.map((t) => t.name());
}

describe("isAllAgentDisallowedTool（Layer 1 判据）", () => {
  test("硬禁名单里的工具判 true", () => {
    for (const name of [
      "monitor",
      "task_stop",
      "task_output",
      "save_memory",
      "enter_plan_mode",
      "exit_plan_mode",
    ]) {
      expect(isAllAgentDisallowedTool(name)).toBe(true);
    }
  });

  test("普通工具判 false", () => {
    for (const name of ["read", "write", "edit", "bash", "grep", "todo_write"]) {
      expect(isAllAgentDisallowedTool(name)).toBe(false);
    }
  });

  test("MCP 工具豁免（名单按内置名写，对 mcp__* 对不上）", () => {
    expect(isAllAgentDisallowedTool("mcp__tavily__tavily_search")).toBe(false);
  });
});

describe("resolveCustomTools 的 allowedTools 分支（硬禁绕过修复）", () => {
  test("frontmatter 声明 monitor → 被裁掉，拿不到", () => {
    const reg = new ToolRegistry();
    reg.register(stubTool("monitor"));
    reg.register(stubTool("read"));
    const agent = makeAgent(reg);

    const tools = (agent as any).resolveCustomTools(customTask(["monitor", "read"]));
    const names = namesOf(tools);

    expect(names).toContain("read");
    expect(names).not.toContain("monitor");
  });

  test("硬禁工具即便写成别名也被裁（大小写归一化后仍判硬禁）", () => {
    const reg = new ToolRegistry();
    reg.register(stubTool("task_stop"));
    const agent = makeAgent(reg);

    const tools = (agent as any).resolveCustomTools(customTask(["TaskStop"]));
    expect(namesOf(tools)).not.toContain("task_stop");
  });

  test("声明不存在的工具 → 不进结果", () => {
    const reg = new ToolRegistry();
    reg.register(stubTool("read"));
    const agent = makeAgent(reg);

    const tools = (agent as any).resolveCustomTools(customTask(["no_such_tool", "read"]));
    expect(namesOf(tools)).toEqual(["read"]);
  });
});
