/**
 * 子代理工具过滤（三层架构）
 *
 * Layer 1（硬性禁止）：所有子代理都不能用的工具
 * Layer 2（角色特定）：内置子代理用白名单，自定义子代理用黑名单
 * Layer 3（Agent 定义级）：每个 Agent 可声明 tools/disallowedTools
 *
 * MCP 工具始终通过硬性过滤（用户显式配置的）
 */

import type { LegacyTool as Tool } from "../tool/types.ts";

/** 所有子代理都不能使用的工具（硬性禁止） */
const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "enter_plan_mode",   // 计划模式是主代理的状态
  "exit_plan_mode",    // 同上
  "save_memory",       // 记忆管理是主代理的职责
]);

/** 自定义 Agent 额外禁止的工具 */
const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  "sub_agent",         // 防止自定义 Agent 递归派生
]);

/** 内置子代理类型的工具白名单 */
const BUILTIN_AGENT_ALLOWED_TOOLS: Record<string, string[] | null> = {
  explore: ["read", "grep", "glob", "ls", "read_many"],
  task: ["read", "write", "edit", "bash", "grep", "glob", "ls", "read_many", "web_fetch", "web_search"],
  plan: ["read", "grep", "glob", "ls", "read_many"],
  summarize: null,  // null = 不需要工具
};

export interface ToolFilterOptions {
  /** 是否为内置子代理类型 */
  isBuiltIn?: boolean;
  /** 内置子代理类型 */
  builtInType?: string;
  /** Agent 定义级工具白名单 */
  tools?: string[];
  /** Agent 定义级工具黑名单 */
  disallowedTools?: string[];
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
): { resolvedTools: Tool[]; invalidToolSpecs: string[] } {
  const isBuiltIn = !!builtInType;

  const resolvedTools = filterToolsForAgent(allTools, {
    isBuiltIn,
    builtInType,
    tools: agentDef.tools,
    disallowedTools: agentDef.disallowedTools,
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
