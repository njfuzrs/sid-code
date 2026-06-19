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
  /** 最大轮次（默认 10） */
  maxTurns?: number;
  /** 超时时间（毫秒，默认 120000） */
  timeout?: number;
  /** 是否只读代理（只读工具不能被误用为写操作） */
  readOnly?: boolean;
  /** 来源：built-in | userSettings */
  source?: "built-in" | "userSettings";
  /** 是否需要在隔离 Worktree 中执行 */
  isolation?: "worktree";
}

// ============================================================
// 内置 Agent 注册表
// ============================================================

export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  explore: {
    agentType: "explore",
    description: "快速搜索和分析代码库，只返回关键发现",
    whenToUse: "当需要搜索代码库、查找文件、理解代码结构时使用。只读操作，不修改文件。",
    systemPrompt: `你是一个代码库探索代理。你的任务是搜索和分析代码，只返回关键发现。
规则：
- 使用 grep、glob、read 工具搜索代码
- 只返回文件路径、行号和关键代码片段
- 保持输出简洁，不要冗长解释
- 完成搜索后，以 "## 发现" 开头输出最终报告，包含：关键文件列表、核心发现、建议的下一步行动
- 标注置信度：对每个关键发现，简短标注确定性（如「已读码确认」「推测，未核实」「未找到，可能不存在」），并显式列出你没能确认的点。不要把推测当事实陈述，让主代理能判断哪些结论需要复核`,
    tools: ["read", "grep", "glob", "ls", "read_many", "task_list"],
    readOnly: true,
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
    tools: ["read", "write", "edit", "bash", "grep", "glob", "ls", "read_many", "web_fetch", "web_search", "task_list"],
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
    tools: ["read", "grep", "glob", "ls", "read_many", "task_list"],
    readOnly: true,
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
    tools: ["read", "grep", "glob", "ls", "read_many", "bash", "task_list"],
    readOnly: true,
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

/** 解析 Agent 定义（先查 builtIn，再查 user dir） */
export function resolveAgent(type: string): AgentDefinition | undefined {
  return BUILTIN_AGENTS[type];
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
// 用户自定义 Agent 加载（M5 实现磁盘加载）
// ============================================================

/**
 * 加载用户自定义 Agent 定义
 * 从 ~/.sid-code/agents/ 或项目 .sid/agents/ 目录加载
 * M5 实现，当前为占位
 */
export async function loadCustomAgents(_dir: string): Promise<AgentDefinition[]> {
  // TODO M5: 扫描目录中的 YAML/JSON 文件，解析为 AgentDefinition
  return [];
}

// ============================================================
// 向后兼容：SubAgentType alias（防止外部引用断裂）
// 注意：SubAgentType 定义在 sub-agent.ts 中，此处仅做类型导出
// ============================================================

export type { SubAgentType } from "./sub-agent.ts";
