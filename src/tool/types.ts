/**
 * 工具系统核心类型
 * 所有工具（内置工具和 MCP 工具）必须实现 Tool 接口
 */

/** 工具执行结果 */
export interface ToolResult {
  output: string;
  isError?: boolean;
}

/** 工具接口 */
export interface Tool {
  /** 工具名称（唯一标识） */
  name(): string;

  /** 工具描述（告诉 AI 这个工具做什么） */
  description(): string;

  /** 参数的 JSON Schema */
  inputSchema(): Record<string, unknown>;

  /** 执行工具操作 */
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
}
