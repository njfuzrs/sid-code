/**
 * LLM 核心类型定义
 * 统一不同 Provider 的消息格式和流式事件
 */

/** 消息角色 */
export type Role = "user" | "assistant";

/** 文本内容块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 工具调用块 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** 工具结果块 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** 内容块类型 */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** 消息 */
export interface Message {
  role: Role;
  content: ContentBlock[];
  _meta?: Record<string, unknown>;
}

/** Token 用量统计 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** 文本增量 */
export interface TextDelta {
  type: "text_delta";
  text: string;
}

/** 工具输入 JSON 增量 */
export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

/** 流式事件类型 */
export type StreamEvent =
  | { type: "message_start"; message: { usage: Usage } }
  | { type: "content_block_start"; index: number; content_block: ContentBlock; _raw_block?: unknown }
  | { type: "content_block_delta"; index: number; delta: TextDelta | InputJsonDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null }; usage: Usage }
  | { type: "message_stop" }
  | { type: "error"; error: { message: string } }
  | { type: "system_api_error"; content: string; delayMs: number; attempt: number; maxRetries: number; category: string };

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 发送消息参数 */
export interface SendParams {
  model: string;
  messages: Message[];
  system?: string;
  maxTokens: number;
  tools?: ToolDefinition[];
  /**
   * 工具调用策略（§4.2）。透传给支持的 provider（OpenAI 兼容）：
   *   - "auto"：模型自行决定是否调用工具（服务端默认）
   *   - "none"：禁止调用工具
   *   - "required"：强制至少调用一个工具
   *   - { name }：强制调用指定工具
   * 不传则不下发该字段，沿用服务端默认。
   */
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /**
   * 是否允许并行工具调用（§4.2）。仅在 provider capabilities.parallelToolCalls 为 true 时有意义。
   * 不传则不下发该字段，沿用服务端默认（通常为 true）。
   */
  parallelToolCalls?: boolean;
  /** Extended Thinking 配置（仅 Anthropic 支持） */
  thinking?: {
    enabled: boolean;
    budgetTokens: number;  // 思考预算 token 数
  };
}

/** 累积的流式响应 */
export interface AccumulatedResponse {
  role: "assistant";
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
  _meta?: Record<string, unknown>;
}
