/**
 * 子代理工具过滤（四层架构）
 *
 * Layer 1（硬性禁止）：所有子代理都不能用的工具
 * Layer 2（角色特定）：内置子代理用白名单，自定义子代理用黑名单
 * Layer 3（Agent 定义级）：每个 Agent 可声明 tools/disallowedTools
 * Layer 4（异步白名单）：后台 Agent 只允许安全子集
 *
 * MCP 工具始终通过硬性过滤（用户显式配置的）
 */

import type { LegacyTool as Tool } from "../tool/types.ts";

/** 所有子代理都不能使用的工具（硬性禁止） */
const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "enter_plan_mode",   // 计划模式是主代理的状态
  "exit_plan_mode",    // 同上
  "save_memory",       // 记忆管理是主代理的职责
  "sub_agent",         // 防嵌套：子代理不允许再 spawn 子代理
  "task_output",       // 子代理不应读取其他任务输出
  "task_stop",         // 子代理不应终止其他任务
]);

/** 自定义 Agent 额外禁止的工具 */
const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  "sub_agent",         // 防止自定义 Agent 递归派生
]);

/** 内置子代理类型的工具白名单 */
const BUILTIN_AGENT_ALLOWED_TOOLS: Record<string, string[] | null> = {
  explore: ["read", "grep", "glob", "ls", "read_many", "task_list"],
  task: ["read", "write", "edit", "bash", "grep", "glob", "ls", "read_many", "web_fetch", "web_search", "task_list"],
  plan: ["read", "grep", "glob", "ls", "read_many", "task_list"],
  verify: ["read", "grep", "glob", "ls", "read_many", "bash", "task_list"],  // 对抗式验证：只读 + bash 核实
  summarize: null,  // null = 不需要工具
  "general-purpose": null, // null = 不限制（由 Layer 3 的 disallowedTools 控制）
};

/** 异步（后台）Agent 的工具白名单 */
const ASYNC_ALLOWED_TOOLS = new Set([
  "read", "read_many", "write", "edit",
  "bash", "grep", "glob", "ls",
  "web_search", "web_fetch", "task_list",
]);

export interface ToolFilterOptions {
  /** 是否为内置子代理类型 */
  isBuiltIn?: boolean;
  /** 内置子代理类型 */
  builtInType?: string;
  /** Agent 定义级工具白名单 */
  tools?: string[];
  /** Agent 定义级工具黑名单 */
  disallowedTools?: string[];
  /** 是否异步执行（后台 Agent） */
  isAsync?: boolean;
}

/**
 * 子代理工具过滤
 */
export function filterToolsForAgent(
  allTools: Tool[],
  options: ToolFilterOptions,
): Tool[] {
  // 内置子代理 summarize 类型不需要工具
  if (options.isBuiltIn && options.builtInType === "summarize") {
    return [];
  }

  return allTools.filter(tool => {
    const name = tool.name();

    // MCP 工具始终通过硬性过滤（用户显式配置的）
    const isMcp = name.startsWith("mcp__");

    // Layer 1: 硬性禁止
    if (!isMcp && ALL_AGENT_DISALLOWED_TOOLS.has(name)) return false;

    // 自定义 Agent 的额外禁止
    if (!options.isBuiltIn && !isMcp && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)) return false;

    // Layer 2: 角色特定（内置子代理用白名单）
    if (options.isBuiltIn && options.builtInType) {
      const allowed = BUILTIN_AGENT_ALLOWED_TOOLS[options.builtInType];
      if (allowed !== undefined && allowed !== null) {
        if (!isMcp && !allowed.includes(name)) return false;
      }
    }

    // Layer 3: Agent 定义级
    // 黑名单
    if (options.disallowedTools?.includes(name)) return false;
    // 白名单（如果指定了且不是 ["*"]）
    if (options.tools && !options.tools.includes("*")) {
      if (!isMcp && !options.tools.includes(name)) return false;
    }

    // Layer 4: 异步白名单（后台 Agent 只允许安全子集）
    if (options.isAsync && !isMcp && !ASYNC_ALLOWED_TOOLS.has(name)) {
      return false;
    }

    return true;
  });
}

/**
 * 解析 Agent 定义的工具配置，返回过滤后的工具列表和无效的工具名
 */
export function resolveAgentTools(
  allTools: Tool[],
  agentDef: { tools?: string[]; disallowedTools?: string[] },
  builtInType?: string,
  isAsync?: boolean,
): { resolvedTools: Tool[]; invalidToolSpecs: string[] } {
  const isBuiltIn = !!builtInType;

  const resolvedTools = filterToolsForAgent(allTools, {
    isBuiltIn,
    builtInType,
    tools: agentDef.tools,
    disallowedTools: agentDef.disallowedTools,
    isAsync,
  });

  // 检查无效的工具名
  const invalidToolSpecs: string[] = [];
  if (agentDef.tools && !agentDef.tools.includes("*")) {
    const resolvedNames = new Set(resolvedTools.map(t => t.name()));
    for (const name of agentDef.tools) {
      if (!resolvedNames.has(name) && !ALL_AGENT_DISALLOWED_TOOLS.has(name)) {
        invalidToolSpecs.push(name);
      }
    }
  }

  return { resolvedTools, invalidToolSpecs };
}
