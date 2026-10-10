/**
 * 子代理工具过滤（四层架构）
 *
 * Layer 1（硬性禁止）：所有子代理都不能用的工具
 * Layer 2（角色特定）：内置子代理用白名单，自定义子代理用黑名单
 * Layer 3（Agent 定义级）：每个 Agent 可声明 tools/disallowedTools
 * Layer 4（异步白名单）：后台 Agent 只允许安全子集
 *
 * MCP 工具只豁免 Layer 1 硬禁（那份名单按内置工具名写，对 MCP 无意义）。
 * Layer 2 只读类型（内置）与 Layer 3 `tools` 白名单（自定义 agent）对 MCP **生效**，放行口只有一个：
 * `tools` 里显式写了这个 MCP 工具的全名（见 explicitlyAllowed）。
 * Layer 4 后台白名单仍豁免 MCP（理由见该层注释）。
 */

import type { LegacyTool as Tool } from "../tool/types.ts";
import { isNestedSubAgentEnabled } from "./depth-context.ts";
import { BUILTIN_AGENTS } from "./agent-definition.ts";

/** 所有子代理都不能使用的工具（硬性禁止） */
const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "enter_plan_mode", // 计划模式是主代理的状态
  "exit_plan_mode", // 同上
  "save_memory", // 记忆管理是主代理的职责
  "task_output", // 子代理不应读取其他任务输出
  "task_stop", // 子代理不应终止其他任务
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

/**
 * 内置子代理类型的工具白名单
 *
 * ⚠️ P1-3（事实源纪律）：本表与 `agent-definition.ts` 各 agent 的 `tools` 字段是
 * **交集**关系（见 filterToolsForAgent 的 Layer 2 / Layer 3）。所以在这里声明一个
 * 定义层没有的工具，等于写了一行**永远不生效**的意图声明——过滤结果里它一定不在。
 *
 * 曾经的实际形态：explore / task / plan / verify 四类的白名单都写着 `todo_write`，
 * 四个定义的 `tools` 字段全都不含它，于是四类子代理全部被裁掉。那一行白名单是死的。
 *
 * 现在的口径：**只读子代理（explore / plan / verify）不要 todo**——它们的产出是一份
 * 报告，不是一串带状态的待办；给了也没人催（子代理循环的回注与门禁只对会写代码的
 * 类型才有意义）。**task 类型要 todo**，它会写代码、会多步执行，正是清单的用武之地，
 * 故 `todo_write` 同时进它的白名单**和**定义层 `tools`。
 * 改动任何一侧都要回头看另一侧，否则又会退回「白名单说可以、定义说不行」。
 * 反漂移断言在 `tests/agent/subagent-todo.test.ts`。
 */
const BUILTIN_AGENT_ALLOWED_TOOLS: Record<string, string[] | null> = {
  // 只读探索：产出是发现报告，不需要带状态的清单
  explore: ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get"],
  task: [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "glob",
    "ls",
    "read_many",
    "web_fetch",
    "web_search",
    "task_list",
    "task_get",
    "task_create",
    "task_update",
    "todo_write",
  ],
  // 只读规划：产出是方案文本
  plan: ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get"],
  verify: ["read", "grep", "glob", "ls", "read_many", "bash", "task_list", "task_get"], // 对抗式验证：只读 + bash 核实
  summarize: null, // null = 不需要工具
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

/**
 * D8：延迟加载调度器。自身 alwaysLoad，不进延迟池；缺了它，子代理即便发
 * activeDefinitions 也激活不了被藏起来的工具（schema 在列表里、激活工具不在）。
 * 放行条件仍受 Layer 1 硬禁 + Layer 3 用户显式 disallowedTools 约束。
 */
const DEFERRED_LOADING_TOOLS = new Set(["tool_search"]);

/** 异步（后台）Agent 的工具白名单 */
const ASYNC_ALLOWED_TOOLS = new Set([
  "read",
  "read_many",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "ls",
  "web_search",
  "web_fetch",
  "task_list",
  "task_get",
  "task_create",
  "task_update",
  "todo_write",
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
export function filterToolsForAgent(allTools: Tool[], options: ToolFilterOptions): Tool[] {
  // 内置子代理 summarize 类型不需要工具
  if (options.isBuiltIn && options.builtInType === "summarize") {
    return [];
  }

  return allTools.filter((tool) => {
    const name = tool.name();

    // MCP 工具只豁免 Layer 1 硬禁类名单（按内置工具名写，对 MCP 对不上）。
    const isMcp = name.startsWith("mcp__");
    // MCP 的显式放行口：Agent 定义的 `tools` 里写了该工具全名。
    // Layer 2 只读类型与 Layer 3 白名单共用这一个口径。
    const explicitlyAllowed = options.tools?.includes(name) === true;

    // Layer 1: 硬性禁止
    if (!isMcp && ALL_AGENT_DISALLOWED_TOOLS.has(name)) return false;

    // P3-1：嵌套受控工具——未开启嵌套时裁掉（等价旧硬禁），开启后留给运行时深度裁决。
    if (!isMcp && NESTING_GATED_TOOLS.has(name) && !isNestedSubAgentEnabled()) return false;

    // 自定义 Agent 的额外禁止
    if (!options.isBuiltIn && !isMcp && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)) return false;

    // P1-3：团队通信工具豁免 Layer 2/4 白名单（见 TEAM_COMMUNICATION_TOOLS 注释）。
    // 仍受 Layer 1 硬禁 + Layer 3 用户显式 disallowedTools 约束（下面的判断在此之前/之后）。
    const isTeamComm = TEAM_COMMUNICATION_TOOLS.has(name);
    // D8：tool_search 豁免 Layer 2/4。general-purpose / 自定义 `"*"` 子代理要延迟加载
    // MCP，必须能调它；explore/plan 白名单不含 MCP，调了也搜不到东西，多一个只读
    // schema 的代价可忽略，换来「子代理循环按池内是否真有 tool_search 定档」一条路。
    const isDeferredLoader = DEFERRED_LOADING_TOOLS.has(name);

    // Layer 2: 角色特定（内置子代理用白名单）
    if (options.isBuiltIn && options.builtInType && !isTeamComm && !isDeferredLoader) {
      const allowed = BUILTIN_AGENT_ALLOWED_TOOLS[options.builtInType];
      if (allowed !== undefined && allowed !== null) {
        // P0（多 provider MCP 放行收紧）：只读子代理（explore/plan/verify）的
        // MCP 工具也受白名单约束。对标 CC agentToolUtils.ts:81-85 同样放行 MCP，
        // 但 CC 靠 claude 模型在 explore system prompt 的 STRICTLY READ-ONLY 约束
        // 下不乱用浏览器工具；sid-code 多 provider（glm/deepseek 等）不能依赖
        // 模型遵从，必须在过滤层硬裁——否则只读子代理会在只读任务里调用
        // playwright/chrome-devtools（2026-07-30 轨迹 20260730-135709 实测事故）。
        // 逃生舱：Agent 定义级 tools 显式声明的 MCP 工具放行（Layer 3 声明，
        // Layer 2 放行），允许用户为某个只读子代理显式授权特定 MCP 工具。
        const isReadOnlyType = BUILTIN_AGENTS[options.builtInType]?.readOnly === true;
        const mcpBypassed = isMcp && !isReadOnlyType;
        if (!mcpBypassed && !explicitlyAllowed && !allowed.includes(name)) {
          return false;
        }
      }
    }

    // Layer 3: Agent 定义级
    // 黑名单
    if (options.disallowedTools?.includes(name)) return false;
    // 白名单（如果指定了且不是 ["*"]）
    // F7（2026-10-07）：此前这里是 `!isMcp && ...`，MCP 被白名单短路 —— 用户写
    // `tools: read, grep` 以为是只读代理，会话连了 playwright 时它照样拿到浏览器工具。
    // 内置只读类型在 Layer 2 已因同一事故（轨迹 20260730-135709）收紧，自定义 agent 没有。
    // 只对自定义 agent 收紧：内置类型的 `tools` 是框架写的能力清单（task 也是显式列表、
    // 不含 MCP 名），它们的 MCP 去留由 Layer 2 的 readOnly 判据决定，这里再裁就是让
    // task 类型整体失去 MCP —— 回退而非收紧。
    const mcpExemptFromWhitelist = isMcp && options.isBuiltIn === true;
    if (options.tools && !options.tools.includes("*")) {
      if (!mcpExemptFromWhitelist && !isDeferredLoader && !options.tools.includes(name)) {
        return false;
      }
    }

    // Layer 4: 异步白名单（后台 Agent 只允许安全子集）
    // F7 取舍：Layer 4 对 MCP 仍豁免。agent 声明了 `tools` 白名单时，Layer 3 已经只放
    // 显式写名的 MCP；没声明（或 `"*"`）即用户授权了全部工具，此处再裁会让
    // general-purpose 后台任务整体失去 MCP，这是一次行为回退而非收紧。
    if (
      options.isAsync &&
      !isMcp &&
      !isTeamComm &&
      !isDeferredLoader &&
      !ASYNC_ALLOWED_TOOLS.has(name)
    ) {
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
    const resolvedNames = new Set(resolvedTools.map((t) => t.name()));
    for (const name of agentDef.tools) {
      // 被策略刻意裁掉的工具不算「无效工具名」——它存在，只是当前不给这个 agent 用。
      // 含硬禁名单 + P3-1 嵌套受控名单（后者在嵌套未开启时被裁掉，属预期而非配置错误）。
      if (
        !resolvedNames.has(name) &&
        !ALL_AGENT_DISALLOWED_TOOLS.has(name) &&
        !NESTING_GATED_TOOLS.has(name)
      ) {
        invalidToolSpecs.push(name);
      }
    }
  }

  return { resolvedTools, invalidToolSpecs };
}
