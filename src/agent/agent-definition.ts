/**
 * Agent 定义系统
 * 对标 claude-code AgentDefinition 接口 + builtInAgents 注册表
 *
 * 原先 SubAgentType 联合类型 + SYSTEM_PROMPTS 字典是硬编码的，
 * 新增 Agent 类型必须改源码。现在改为 AgentDefinition 接口，
 * builtIn 注册表 + 预留 user dir 加载，实现可拔插化。
 */

// ============================================================
// Agent 定义接口（对标 claude-code AgentDefinition）
// ============================================================

export interface AgentDefinition {
  /** 唯一标识符（"explore", "task" 等） */
  agentType: string;
  /** 简短描述（日志/TUI 显示） */
  description: string;
  /** LLM prompt 中的使用指南（whenToUse） */
  whenToUse: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 工具白名单（undefined = 不限制，由 tool-filter 层控制） */
  tools?: string[];
  /** 工具黑名单 */
  disallowedTools?: string[];
  /** 模型覆盖（undefined = 继承主模型） */
  model?: string;
  /**
   * 语义模型档位（P0-1，对齐 CC 给 Explore pin haiku 的成本设计）。
   * "cheap" 高频只读代理（explore/plan/summarize）省 token；"strong" 需最强模型；"default" 跟主模型。
   * 不硬编码模型名（铁律 feedback-no-hardcoded-model-tier-rules）——档位→实际模型由
   * registry.getModelForSubAgent 从「已注册模型按价格排序 + 环境变量」派生，fail-open 回退主模型。
   * 优先级：task.model 每次调用覆盖 > subAgentModels[type] 用户配置 > model 字段 > modelTier 档位 > 主模型。
   */
  modelTier?: "cheap" | "default" | "strong";
  /**
   * 预加载技能名列表（P1-1，对齐 CC §11.8 角色链最佳实践）。
   * spawn 时把这些 skill 的内容作为「预加载专业知识」段注入子代理 system prompt。
   * skill 不存在时 warn 跳过，不 spawn 失败。
   */
  skills?: string[];
  /**
   * UI 区分色（P1-2，对齐 CC frontmatter color）。
   * 声明后该 agent 的进度/结果行用此色；未声明走 assignAgentColor 哈希分配。
   * 校验是否在允许色板内（见 color.ts PALETTE），非法值 warn 跳过用默认分配色。
   */
  color?: string;
  /**
   * 权限模式（P2-1，对齐 CC frontmatter permissionMode）。
   * 声明后子代理用此权限模式（如 acceptEdits/plan）。非法值 warn 跳过。
   */
  permissionMode?: string;
  /**
   * agent 专用 hooks（P2-1，对齐 CC frontmatter hooks + §11.8「子代理专用 hooks」）。
   * 结构与 settings.json hooks 一致；spawn 时注册到该子代理的 hook 系统。
   */
  hooks?: unknown;
  /** 最大轮次（默认 10） */
  maxTurns?: number;
  /** 超时时间（毫秒，默认 120000） */
  timeout?: number;
  /** 是否只读代理（只读工具不能被误用为写操作） */
  readOnly?: boolean;
  /** 来源：built-in | userSettings | plugin（对标 cc AgentSource） */
  source?: "built-in" | "userSettings" | "plugin";
  /** 是否需要在隔离 Worktree 中执行 */
  isolation?: "worktree";
  /** 上下文窗口大小（tokens，undefined = 跟随主模型窗口）。对标 cc maxTokens。 */
  maxTokens?: number;
  /** 是否默认后台异步执行（对标 cc background 字段，coordinator/审计类常驻后台） */
  background?: boolean;
  /** 是否省略主代理 CLAUDE.md 上下文（对标 cc omitClaudeMd，只读探查类省 token） */
  omitClaudeMd?: boolean;
  /** 来源文件路径（自定义/插件 agent 用于溯源；built-in 为空） */
  filePath?: string;
}

// ============================================================
// 内置 Agent 注册表
// ============================================================

export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  explore: {
    agentType: "explore",
    description: "快速搜索和分析代码库，只返回关键发现",
    whenToUse: "当需要搜索代码库、查找文件、理解代码结构时使用。只读操作，不修改文件。派活时在 prompt 里指明彻底程度：quick（快速定位单个文件/符号）/ medium（适度探索，覆盖主要相关点）/ very thorough（多处、多命名约定的全面分析）——不同程度对应不同的搜索深度。",
    systemPrompt: `你是一个代码库探索代理。你的任务是搜索和分析代码，只返回关键发现。你被设计为一个快速代理，尽可能快地返回结果。
规则：
- 使用 grep、glob、read 工具搜索代码
- 根据调用方在 prompt 中指定的彻底程度调整搜索深度：quick 只做最小必要搜索快速定位；medium 覆盖主要相关点；very thorough 时探索多处位置与多种命名约定，力求全面。未指定时按 medium 处理。
- 只返回文件路径、行号和关键代码片段
- 保持输出简洁，不要冗长解释
- 完成搜索后，以 "## 发现" 开头输出最终报告，包含：关键文件列表、核心发现、建议的下一步行动
- 标注置信度：对每个关键发现，简短标注确定性（如「已读码确认」「推测，未核实」「未找到，可能不存在」），并显式列出你没能确认的点。不要把推测当事实陈述，让主代理能判断哪些结论需要复核`,
    tools: ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get"],
    readOnly: true,
    // P0-1：explore 是高频只读搜索代理，pin 便宜档省 token（对齐 CC 给 Explore 固定 haiku）。
    modelTier: "cheap",
    // explore 常被派去读 7-11 个文件 + 多轮 grep，每轮都要等 LLM 响应；
    // 慢模型（glm/deepseek 等）下 120s 明显不够，给足 300s。
    timeout: 300_000,
    source: "built-in",
  },

  task: {
    agentType: "task",
    description: "执行指定的子任务并返回结果",
    whenToUse: "当需要完成具体的编码子任务时使用。可以读写文件、执行命令。",
    systemPrompt: `你是一个任务执行代理。你的任务是完成指定的子任务并返回结果。
规则：
- 专注于完成指定任务
- 完成后以 "## 结果" 开头简洁地报告完成状态和关键输出
- 如果遇到问题，以 "## 问题" 开头说明原因和可能的解决方案
- 标注置信度：对关键结论标注确定性（如「已验证」「推测，未确认」），并显式列出你没能确认或留有疑问的点，让主代理能判断哪些结果需要复核。不要把未验证的推测当作已完成的事实陈述`,
    tools: ["read", "write", "edit", "bash", "grep", "glob", "ls", "read_many", "web_fetch", "web_search", "task_list", "task_get", "task_create", "task_update"],
    // task 常做多步编码 + 命令执行，比 explore 更重；给足 300s。
    timeout: 300_000,
    source: "built-in",
  },

  summarize: {
    agentType: "summarize",
    description: "总结对话内容，提取关键信息",
    whenToUse: "当需要总结对话历史、提取关键决策和待办事项时使用。不需要任何工具。",
    systemPrompt: `你是一个摘要代理。你的任务是总结对话内容。
规则：
- 保留关键信息：文件路径、代码修改、决策、待办事项
- 使用中文
- 保持简洁
- 完成后以 "## 摘要" 开头输出结构化摘要`,
    // summarize 不需要工具
    // P0-1：摘要是纯文本压缩任务，pin 便宜档省 token。
    modelTier: "cheap",
    timeout: 180_000,
    source: "built-in",
  },

  plan: {
    agentType: "plan",
    description: "分析代码库并输出结构化的实现方案",
    whenToUse: "当需要分析现有代码、设计实现方案时使用。只读操作，不修改文件。",
    systemPrompt: `你是一个代码分析和规划代理。分析代码库并输出结构化的实现方案。
规则：
- 使用 grep、glob、read 工具搜索和阅读代码
- 不要修改任何文件
- 完成后以 "## 方案" 开头输出：问题分析、方案设计、涉及文件、实现步骤`,
    tools: ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get"],
    readOnly: true,
    // P0-1：plan 只读分析代理，pin 便宜档省 token。
    modelTier: "cheap",
    // plan 只读但需要大量阅读代码，给足 240s。
    timeout: 240_000,
    source: "built-in",
  },

  "general-purpose": {
    agentType: "general-purpose",
    description: "通用 Agent，拥有全部工具集，适合复杂的多步骤任务",
    whenToUse: "当需要完成复杂的多步骤研究、搜索或编码任务时使用。拥有全部工具（除 sub_agent 外），是省略 type 时的默认兜底类型。",
    systemPrompt: `你是一个通用任务执行代理。你拥有完整的工具集来完成复杂任务。
规则：
- 分析任务需求，选择合适的工具组合
- 按步骤执行，每步验证结果
- 完成后以 "## 结果" 开头简洁地报告完成状态和关键变更
- 标注置信度：对关键结论标注确定性（如「已验证」「推测，未确认」），并显式列出你没能确认的点`,
    tools: ["*"],
    disallowedTools: ["sub_agent"],
    // 通用代理执行多步骤复杂任务，给足 360s。
    timeout: 360_000,
    source: "built-in",
  },

  verify: {
    agentType: "verify",
    description: "对抗式验证：验证给定结论/修复/发现是否真实成立",
    whenToUse: "当需要验证某个结论或修复是否真实有效时使用。持怀疑态度，主动寻找反例。只读 + bash 核实。",
    systemPrompt: `你是一个对抗式验证代理。你的唯一任务是：判断给定的结论/修复/发现/bug 是否真实成立——并默认它**可能是错的**。

你不是来"确认"的，你是来"推翻"的。能证伪一条看似合理但实际错误的结论，与确认一条正确结论同样有价值，绝不是失败。

## 四条铁律

1. **默认怀疑，主动证伪**
   - 把待验证结论当作"待推翻的假设"，而不是"待背书的事实"。
   - 先问：它在什么情况下会是错的？然后去代码里找那个情况。
   - 警惕"看起来对"——提示词或原报告给的叙事可能本身就是错的，不要顺着它的框架走。

2. **必须读码举证，禁止凭空盖章**
   - 每一条裁定都必须附**精确证据**：\`文件:行号\` + 该处的**实际代码片段**。
   - 读够上下文，不要只看被引用的那一行（一行代码的含义常常取决于它前后的分支、Map 暂存、注释）。
   - 没有 \`文件:行号\` 证据支撑的裁定，一律降为"无法验证"。

3. **"导出但无人调用 / 死代码 / 状态残留"类结论：先 grep 出调用方再说**
   - 声称某函数/字段是孤儿、死代码、从未被赋值/读取之前，**必须** \`grep\` 出它的全部定义点、赋值点、调用点、读取点，把计数贴进证据。
   - 一个常见陷阱：某字段看似"漏重置"，但它根本不在那个数据结构里（属于另一层 hook/prop）——这是范畴错误，不是 bug。grep 清楚它到底住在哪，再下结论。

4. **不确定就降级，不要赌**
   - 裁定分四档：**CONFIRMED**（读码确认成立）/ **REFUTED**（读码确认是错的）/ **PARTIAL**（部分成立，或现象真但根因/严重度被误判）/ **UNVERIFIABLE**（需运行时，代码层无法判定）。
   - 除非读码能确认，否则不要给 CONFIRMED；宁可 PARTIAL / UNVERIFIABLE。
   - 顺带校准严重度：原结论说"高/P0"，但实际被其它机制兜住/缓解了，要如实指出"严重度被高估"。

## 输出格式

以 "## 结论" 开头，对每条待验证项输出：
- **裁定**：CONFIRMED / REFUTED / PARTIAL / UNVERIFIABLE
- **证据**：\`文件:行号\` + 实际代码（这是硬性要求，不能省）
- **证伪尝试**：我如何试图推翻它、结果如何
- **严重度校准**：原定级是否准确，是否高估/低估`,
    tools: ["read", "grep", "glob", "ls", "read_many", "bash", "task_list", "task_get"],
    readOnly: true,
    // verify 需要多轮文件读取 + grep + 逐一读码举证，与 explore 同级，给足 300s。
    timeout: 300_000,
    source: "built-in",
  },
};

// ============================================================
// 查询方法
// ============================================================

/** 获取内置 Agent 类型列表 */
export function getBuiltInAgentTypes(): string[] {
  return Object.keys(BUILTIN_AGENTS);
}

/**
 * 获取内置 Agent 完整定义列表（缺口 F）。
 *
 * 与 getBuiltInAgentTypes（仅返回类型名）互补：sub_agent 工具的 description 需要把
 * 每种类型的能力（description）+ 工具集边界（tools）暴露给模型，否则模型派活时只能
 * 凭类型名猜能力，可能把"需要写文件"的活派给只读的 explore，撞墙后才反馈失败。
 *
 * 返回顺序与 BUILTIN_AGENTS 声明顺序一致（Object.values 保序）。
 */
export function getBuiltInAgentDefinitions(): AgentDefinition[] {
  return Object.values(BUILTIN_AGENTS);
}

/**
 * 解析 Agent 定义。
 *
 * 先查动态聚合 registry（built-in + custom + plugin，见 registerDynamicAgents），
 * 未命中再回退到 BUILTIN_AGENTS。这样自定义/插件 agent 也能被 sub_agent 的 type 直接解析，
 * 与内置类型同源——对标 cc：所有 agent 走同一 AgentDefinition，统一经 subagent_type 访问。
 */
export function resolveAgent(type: string): AgentDefinition | undefined {
  return dynamicAgents.get(type) ?? BUILTIN_AGENTS[type];
}

/** 获取 Agent 的系统提示词（带 fallback） */
export function getAgentSystemPrompt(type: string): string | undefined {
  return resolveAgent(type)?.systemPrompt;
}

/** 获取 Agent 的 whenToUse 描述 */
export function getAgentWhenToUse(type: string): string | undefined {
  return resolveAgent(type)?.whenToUse;
}

// ============================================================
// 统一 Agent 聚合 Registry（对标 cc getAgentDefinitionsWithOverrides）
//
// cc 把 built-in + custom(user/project settings) + plugin 三类来源聚合成一个
// "活跃 agent 列表"，按优先级去重覆盖（built-in < plugin < user < project），
// 主 LLM 通过同一个 Agent 工具的 subagent_type 访问任何一类。
//
// sid 此前三条路径割裂：内置走 sub_agent 的 type 枚举；自定义/插件各自包装成
// 独立的 agent__xxx 工具。割裂的代价：① 自定义 agent 无法复用 sub_agent 的
// run_in_background / isolation / 并发控制；② 主 LLM 要在"选 sub_agent type"和
// "调 agent__xxx 工具"两套心智间切换。
//
// 这里建立 cc 式聚合：把运行期发现的自定义/插件 agent 注册进 dynamicAgents，
// resolveAgent / getActiveAgentDefinitions / SubAgentTool 的 type 枚举全部据此派生。
// ============================================================

/** 运行期注册的动态 agent（自定义 + 插件），key = agentType。 */
const dynamicAgents = new Map<string, AgentDefinition>();

/**
 * 注册一批动态 agent 定义（自定义 / 插件）到聚合 registry。
 *
 * 优先级（对标 cc getActiveAgentsFromList 的 built-in < plugin < user < project）：
 * - overwrite=true（默认，用户自定义用）：同名时覆盖已有定义，让用户定义胜出。
 * - overwrite=false（插件用）：同名时不覆盖——插件优先级低于用户自定义，
 *   即便插件在用户 agent 之后注册，也不会顶掉用户的同名 agent。
 */
export function registerDynamicAgents(defs: AgentDefinition[], overwrite = true): void {
  for (const def of defs) {
    if (!def.agentType) continue;
    if (!overwrite && dynamicAgents.has(def.agentType)) continue;
    dynamicAgents.set(def.agentType, def);
  }
}

/** 清空动态 agent 注册（测试 / 重新发现时用）。 */
export function clearDynamicAgents(): void {
  dynamicAgents.clear();
}

/**
 * 获取当前活跃的全部 Agent 定义（built-in + 已注册的 custom/plugin）。
 *
 * 这是给 SubAgentTool.description() 和 type 枚举用的单一真相源——
 * 新增任何来源的 agent 都会自动出现在 sub_agent 的可选类型里，无需改 schema 代码。
 * 保序：built-in 在前（声明序），dynamic 在后（注册序），同名 dynamic 覆盖 built-in 的值
 * 但保持 built-in 的位置。
 */
export function getActiveAgentDefinitions(): AgentDefinition[] {
  const result: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const def of Object.values(BUILTIN_AGENTS)) {
    result.push(dynamicAgents.get(def.agentType) ?? def);
    seen.add(def.agentType);
  }
  for (const [type, def] of dynamicAgents) {
    if (!seen.has(type)) result.push(def);
  }
  return result;
}

/** 获取当前活跃的全部 Agent 类型名（built-in + custom + plugin）。 */
export function getActiveAgentTypes(): string[] {
  return getActiveAgentDefinitions().map((d) => d.agentType);
}

// ============================================================
// 向后兼容：SubAgentType alias（防止外部引用断裂）
// 注意：SubAgentType 定义在 sub-agent.ts 中，此处仅做类型导出
// ============================================================

export type { SubAgentType } from "./sub-agent.ts";
