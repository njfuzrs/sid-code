/**
 * AgentDefinition — Agent 完整蓝图
 * 定义 Agent 的类型、工具集、模型、超时等配置
 */

export type AgentSource = "built-in" | "custom" | "skill";

export interface AgentDefinition {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  timeout?: number;
  omitClaudeMd?: boolean;
  background?: boolean;
  source: AgentSource;
  getSystemPrompt(): string;
}

/** 内置 Agent 定义 */
export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    agentType: "explore",
    whenToUse: "搜索和分析代码库，返回关键发现。适合快速定位文件、函数、模式。",
    tools: ["read", "grep", "glob", "ls", "read_many"],
    maxTurns: 10,
    maxTokens: 50000,
    timeout: 120_000,
    source: "built-in",
    getSystemPrompt() {
      return `你是一个代码库探索代理。你的任务是搜索和分析代码，只返回关键发现。
规则：
- 使用 grep、glob、read 工具搜索代码
- 只返回文件路径、行号和关键代码片段
- 保持输出简洁，不要冗长解释`;
    },
  },
  {
    agentType: "task",
    whenToUse: "执行特定的编码子任务，可以读写文件和执行命令。",
    tools: ["read", "write", "edit", "bash", "grep", "glob", "ls", "read_many", "web_fetch", "web_search"],
    maxTurns: 10,
    maxTokens: 50000,
    timeout: 120_000,
    source: "built-in",
    getSystemPrompt() {
      return `你是一个任务执行代理。你的任务是完成指定的子任务并返回结果。
规则：
- 专注于完成指定任务
- 完成后简洁地报告结果
- 如果遇到问题，说明原因`;
    },
  },
  {
    agentType: "plan",
    whenToUse: "分析代码库并输出结构化的实现方案。只读，不修改文件。",
    tools: ["read", "grep", "glob", "ls", "read_many"],
    maxTurns: 15,
    maxTokens: 50000,
    timeout: 120_000,
    source: "built-in",
    getSystemPrompt() {
      return `你是一个代码分析和规划代理。分析代码库并输出结构化的实现方案。
规则：
- 使用 grep、glob、read 工具搜索和阅读代码
- 输出包含：问题分析、方案设计、涉及文件、实现步骤
- 不要修改任何文件，保持输出简洁可操作`;
    },
  },
  {
    agentType: "summarize",
    whenToUse: "总结大量内容，保留关键信息。不需要工具。",
    tools: [],
    maxTurns: 1,
    maxTokens: 20000,
    timeout: 30_000,
    source: "built-in",
    getSystemPrompt() {
      return `你是一个摘要代理。你的任务是总结对话内容。
规则：
- 保留关键信息：文件路径、代码修改、决策、待办事项
- 使用中文
- 保持简洁`;
    },
  },
  {
    agentType: "general-purpose",
    whenToUse: "通用 Agent，拥有全部工具集。适合复杂的多步骤任务。",
    tools: ["*"],
    disallowedTools: ["sub_agent"],
    maxTurns: 20,
    maxTokens: 80000,
    timeout: 300_000,
    source: "built-in",
    getSystemPrompt() {
      return `你是一个通用任务执行代理。你拥有完整的工具集来完成复杂任务。
规则：
- 分析任务需求，选择合适的工具
- 按步骤执行，每步验证结果
- 完成后简洁地报告结果和关键变更`;
    },
  },
];

/** 按 agentType 查找 AgentDefinition */
export function resolveAgentDefinition(agentType: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS.find(a => a.agentType === agentType);
}

/** 获取所有内置 Agent 类型名 */
export function getBuiltInAgentTypes(): string[] {
  return BUILT_IN_AGENTS.map(a => a.agentType);
}
