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

  /** 是否为只读工具（只读工具可以并行执行） */
  readOnly?(): boolean;

  /**
   * 基于输入参数判断是否并发安全（P1-2）
   * 比 readOnly() 更细粒度：同一个工具在不同输入下可能有不同的并发安全性
   * 例如 BashTool：ls/cat 是安全的，rm/mv 不安全
   * 默认回退到 readOnly()
   */
  isConcurrencySafe?(input: unknown): boolean;

  /** 工具使用指南（告诉 AI 何时以及如何使用此工具） */
  usageGuide?(): string;
}
