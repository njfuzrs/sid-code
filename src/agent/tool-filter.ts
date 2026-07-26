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
import { isNestedSubAgentEnabled } from "./depth-context.ts";

/** 所有子代理都不能使用的工具（硬性禁止） */
const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "enter_plan_mode",   // 计划模式是主代理的状态
  "exit_plan_mode",    // 同上
  "save_memory",       // 记忆管理是主代理的职责
  "task_output",       // 子代理不应读取其他任务输出
  "task_stop",         // 子代理不应终止其他任务
  // 注: todo_write 曾因全局单实例并发写污染主会话被一律禁用; P1-2 已改为每个进程内子代理在
  // buildIsolatedToolRegistry 拿独立 TodoWriteTool 实例 (spawn 路径本就是独立子进程),
  // 污染根因消除, 恢复子代理 todo 追踪能力对齐 CC per-agent 命名空间, 故不再禁用。
  //
  // 注: sub_agent 不在此硬禁名单里——P3-1 起改由 NESTING_GATED_TOOLS 条件裁决
  // （嵌套未开启时等价于硬禁，开启后交给 depth-context 按深度上限放行）。
]);

/**
 * P3-1：受嵌套开关约束的工具。
 *
 * 嵌套未开启（默认）：从子代理工具池裁掉，行为等价于此前的硬性禁止。
 * 嵌套已开启：保留在池里，由 tool.ts 的 canSpawnSubAgent() 按**实际深度**裁决——
 * 深度未达上限则放行，达上限则返回明确错误让模型改换策略。
 *
 * 为什么不干脆一直保留、只靠运行时判断：未开启时把工具留在池里，模型会反复尝试调用
 * 再吃错误，白烧 token。裁掉是更省的表达。
 */
const NESTING_GATED_TOOLS = new Set(["sub_agent"]);

/** 自定义 Agent 额外禁止的工具（自定义 agent 的递归派生同样受嵌套开关约束）。 */
const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set<string>([]);

/** 内置子代理类型的工具白名单 */
const BUILTIN_AGENT_ALLOWED_TOOLS: Record<string, string[] | null> = {
  explore: ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get", "todo_write"],
  task: ["read", "write", "edit", "bash", "grep", "glob", "ls", "read_many", "web_fetch", "web_search", "task_list", "task_get", "task_create", "task_update", "todo_write"],
  plan: ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get", "todo_write"],
  verify: ["read", "grep", "glob", "ls", "read_many", "bash", "task_list", "task_get", "todo_write"],  // 对抗式验证：只读 + bash 核实
  summarize: null,  // null = 不需要工具
  "general-purpose": null, // null = 不限制（由 Layer 3 的 disallowedTools 控制）
};

/**
 * P1-3：团队通信工具——永不被 Layer 2 白名单 / Layer 4 异步白名单裁掉。
 *
 * 团队成员的 agentType 是普通类型（explore/task/...），若按各自白名单过滤，
 * team_message 会被裁掉，成员就只能读收件箱不能回消息——双向通信又断成单向。
 * 该工具只往邮箱投递（isReadOnly，不改文件不执行命令），且非团队上下文调用会
 * 明确报错，故对任何 agent 类型放行都是安全的。
 */
const TEAM_COMMUNICATION_TOOLS = new Set(["team_message"]);

/** 异步（后台）Agent 的工具白名单 */
const ASYNC_ALLOWED_TOOLS = new Set([
  "read", "read_many", "write", "edit",
  "bash", "grep", "glob", "ls",
  "web_search", "web_fetch",
  "task_list", "task_get", "task_create", "task_update", "todo_write",
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

    // P3-1：嵌套受控工具——未开启嵌套时裁掉（等价旧硬禁），开启后留给运行时深度裁决。
    if (!isMcp && NESTING_GATED_TOOLS.has(name) && !isNestedSubAgentEnabled()) return false;

    // 自定义 Agent 的额外禁止
    if (!options.isBuiltIn && !isMcp && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)) return false;

    // P1-3：团队通信工具豁免 Layer 2/4 白名单（见 TEAM_COMMUNICATION_TOOLS 注释）。
    // 仍受 Layer 1 硬禁 + Layer 3 用户显式 disallowedTools 约束（下面的判断在此之前/之后）。
    const isTeamComm = TEAM_COMMUNICATION_TOOLS.has(name);

    // Layer 2: 角色特定（内置子代理用白名单）
    if (options.isBuiltIn && options.builtInType && !isTeamComm) {
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
    if (options.isAsync && !isMcp && !isTeamComm && !ASYNC_ALLOWED_TOOLS.has(name)) {
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
      // 被策略刻意裁掉的工具不算「无效工具名」——它存在，只是当前不给这个 agent 用。
      // 含硬禁名单 + P3-1 嵌套受控名单（后者在嵌套未开启时被裁掉，属预期而非配置错误）。
      if (!resolvedNames.has(name) && !ALL_AGENT_DISALLOWED_TOOLS.has(name) && !NESTING_GATED_TOOLS.has(name)) {
        invalidToolSpecs.push(name);
      }
    }
  }

  return { resolvedTools, invalidToolSpecs };
}
