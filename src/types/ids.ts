/**
 * Branded Types — 编译期 ID 混淆防护（对齐 Claude Code 的 Branded Types 模式）
 *
 * 问题：SessionId、AgentId、ToolCallId 在运行时都是普通字符串，
 * 裸 `string` 类型无法阻止把 SessionId 误传给期望 AgentId 的函数——
 * 这类 bug 在运行时才暴露，难以追踪。
 *
 * 解法：用「品牌（brand）」给字符串打上编译期标记。运行时零成本
 * （仍是字符串），但编译期是互不兼容的类型，传错会直接编译报错。
 *
 * 采用方式（渐进式）：本模块定义类型与转换函数作为统一入口。
 * 现有裸 string 调用点可逐步迁移——新代码优先用 branded 类型，
 * 在「字符串进入系统的边界」处用 asXxx() 转换一次即可。
 */

/** 会话唯一标识 */
export type SessionId = string & { readonly __brand: "SessionId" };

/** 子代理唯一标识 */
export type AgentId = string & { readonly __brand: "AgentId" };

/** 工具调用唯一标识（对应 API 的 tool_use.id） */
export type ToolCallId = string & { readonly __brand: "ToolCallId" };

/** 把裸字符串标记为 SessionId（在边界处调用一次） */
export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

/** 把裸字符串标记为 AgentId */
export function asAgentId(id: string): AgentId {
  return id as AgentId;
}

/** 把裸字符串标记为 ToolCallId */
export function asToolCallId(id: string): ToolCallId {
  return id as ToolCallId;
}
