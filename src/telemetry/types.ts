/**
 * 遥测核心类型定义
 * 遵循 OTel GenAI 语义约定的数据模型
 */

/** Span 状态 */
export type SpanStatus = "ok" | "error" | "unset";

/** Span 类型——对应 OTel GenAI 的 operation.name */
export type SpanKind =
  | "invoke_agent"    // Agent 调用（顶层）
  | "chat"            // LLM 推理调用
  | "execute_tool";   // 工具执行

/** 属性值类型——OTel 兼容 */
export type AttributeValue = string | number | boolean | string[] | number[];

/** 属性集合 */
export type Attributes = Record<string, AttributeValue>;

/** Span 事件（轻量级，不创建独立 Span） */
export interface SpanEvent {
  name: string;
  timestamp: number;       // Unix 毫秒
  attributes?: Attributes;
}

/** 完成的 Span 数据 */
export interface SpanData {
  // === 标识 ===
  traceId: string;         // 32 字符十六进制（W3C Trace Context）
  spanId: string;          // 16 字符十六进制
  parentSpanId?: string;   // 父 Span ID（顶层 Span 无此字段）

  // === 语义 ===
  name: string;            // 格式: "{operation} {target}"
  kind: SpanKind;
  status: SpanStatus;

  // === 时间 ===
  startTime: number;       // Unix 毫秒
  endTime: number;         // Unix 毫秒
  durationMs: number;      // endTime - startTime

  // === 数据 ===
  attributes: Attributes;  // OTel GenAI 标准属性
  events: SpanEvent[];     // Span 内的事件序列
  error?: {                // 错误信息（仅 status=error 时）
    type: string;
    message: string;
    stack?: string;
  };
}

/** Metric 数据点 */
export interface MetricPoint {
  name: string;            // 如 "gen_ai.client.token.usage"
  value: number;
  timestamp: number;
  attributes: Attributes;  // 维度标签
  type: "counter" | "histogram" | "gauge";
}

/** 导出器接口——所有后端实现此接口 */
export interface TelemetryExporter {
  name: string;
  exportSpans(spans: SpanData[]): Promise<void>;
  exportMetrics?(metrics: MetricPoint[]): Promise<void>;
  shutdown(): Promise<void>;
}

/** 遥测配置 */
export interface TelemetryConfig {
  enabled: boolean;
  exporters: TelemetryExporterConfig[];
  batchSize: number;       // 批量导出大小，默认 512
  flushIntervalMs: number; // 刷新间隔，默认 5000
  maxQueueSize: number;    // 最大队列大小，默认 2048
}

export interface TelemetryExporterConfig {
  type: "console" | "jsonl";
  options?: Record<string, unknown>;
}

/** OTel GenAI 标准属性名常量 */
export const ATTR = {
  // GenAI 标准
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_MODEL: "gen_ai.request.model",
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  CACHE_READ_TOKENS: "gen_ai.usage.cache_read.input_tokens",
  CACHE_CREATION_TOKENS: "gen_ai.usage.cache_creation.input_tokens",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  CONVERSATION_ID: "gen_ai.conversation.id",
  AGENT_NAME: "gen_ai.agent.name",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  // sid-code 扩展
  TURN_NUMBER: "sidcode.turn_number",
  USER_PROMPT: "sidcode.user_prompt",
  CWD: "sidcode.cwd",
  TOTAL_TURNS: "sidcode.total_turns",
  TOTAL_COST_USD: "sidcode.total_cost_usd",
  SUCCESS: "sidcode.success",
  TOOL_ARGS_SUMMARY: "sidcode.tool.args_summary",
  TOOL_RESULT_SIZE: "sidcode.tool.result_size_bytes",
  TOOL_FILE_PATH: "sidcode.tool.file_path",
  TOOL_COMMAND: "sidcode.tool.command",
} as const;
