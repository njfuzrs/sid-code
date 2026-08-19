/**
 * 遥测核心类型定义
 * 遵循 OTel GenAI 语义约定的数据模型
 */

/** Span 状态 */
export type SpanStatus = "ok" | "error" | "unset";

/** Span 类型——对应 OTel GenAI 的 operation.name */
export type SpanKind =
  | "invoke_agent" // Agent 调用（顶层）
  | "chat" // LLM 推理调用
  | "execute_tool" // 工具执行
  | "blocked_on_user" // 等待用户权限确认（spec 17 §6.1.3）
  | "hook_execution"; // Hook 执行（spec 17 §6.1.3）

/** 属性值类型——OTel 兼容 */
export type AttributeValue = string | number | boolean | string[] | number[];

/** 属性集合 */
export type Attributes = Record<string, AttributeValue>;

/** Span 事件（轻量级，不创建独立 Span） */
export interface SpanEvent {
  name: string;
  timestamp: number; // Unix 毫秒
  attributes?: Attributes;
}

/** 完成的 Span 数据 */
export interface SpanData {
  // === 标识 ===
  traceId: string; // 32 字符十六进制（W3C Trace Context）
  spanId: string; // 16 字符十六进制
  parentSpanId?: string; // 父 Span ID（顶层 Span 无此字段）

  // === 语义 ===
  name: string; // 格式: "{operation} {target}"
  kind: SpanKind;
  status: SpanStatus;

  // === 时间 ===
  startTime: number; // Unix 毫秒
  endTime: number; // Unix 毫秒
  durationMs: number; // endTime - startTime

  // === 数据 ===
  attributes: Attributes; // OTel GenAI 标准属性
  events: SpanEvent[]; // Span 内的事件序列
  error?: {
    // 错误信息（仅 status=error 时）
    type: string;
    message: string;
    stack?: string;
  };
}

/** Metric 数据点 */
export interface MetricPoint {
  name: string; // 如 "gen_ai.client.token.usage"
  value: number;
  timestamp: number;
  attributes: Attributes; // 维度标签
  type: "counter" | "histogram" | "gauge";
  /**
   * 分桶（仅 `type: "histogram"` 有意义）。**不带它的 histogram 会被 OTLP 导出器
   * 降级成 gauge**，这个降级是刻意保留的：硬造 bucket 边界得出的分布是错的
   * （见 `exporters/otlp.ts` 的 `toOtlpMetric`）。
   *
   * ## 为什么是「单点 + 桶」而不是「聚合后的桶计数」
   *
   * 一次 `recordMetric` 描述的是**一个观测值**（一次 TTFT、一轮 turns），
   * 不是一个已经聚合好的窗口。所以这里只记「这个值落在哪条边界划出的哪个桶里」，
   * 真正的 count/sum 聚合由导出器在 flush 时按 (name, attributes) 合并完成。
   * 这样 `value` 始终保留原始观测值 —— 报告层与 `/telemetry` 的
   * `aggregateMetrics()` 仍能直接对它做 sum/max，不必理解分桶。
   *
   * `bounds` 是**上界递增**的显式边界数组，语义与 OTLP `explicitBounds` 一致：
   * n 条边界划出 n+1 个桶，最后一个桶是 `(bounds[n-1], +∞)`。
   */
  buckets?: {
    /** 显式桶边界（上界，严格递增）。空数组表示"只有一个 (-∞,+∞) 桶"，无意义，勿传 */
    bounds: number[];
  };
}

/**
 * TTFT 直方图的桶边界（毫秒）。
 *
 * 取值依据是实测分布而非拍脑袋：`deepseek-v4-pro` 的 TTFT p50 已经到 3983ms，
 * 而 `glm-5.3` 之类走本地路由的在 500ms 内（见 `trace/latency-by-model.ts` 的表）。
 * 边界必须同时覆盖这两端，否则一族全落进首桶、另一族全落进尾桶，
 * 分布图上看不出任何东西 —— 那正是"有指标但值是废的"那类缺陷。
 *
 * 尾部特意拉到 60s：慢首字节实测有 102.8s 的样本（见 `agent/agentic-loop.ts` 的
 * P2-6 注释），截在 10s 会把所有病态样本压进同一个尾桶，
 * 而"慢尾巴才是用户流失点"正是要看的东西。
 */
export const TTFT_BUCKET_BOUNDS_MS = [
  100, 250, 500, 1000, 2000, 3000, 5000, 8000, 15000, 30000, 60000,
] as const;

/**
 * 单轮 turns 直方图的桶边界。
 *
 * 依据实测「轮数 vs e2e 相关系数 r = 0.767」——轮数是端到端耗时最强的解释变量，
 * 也是成本的最大杠杆（2× 轮数 ≈ 3–4× 成本，因为后段每轮的 input 都更大）。
 * 边界照着实测分组走（1–2 / 3–8 / 9–20 / 21+），
 * 在低位加密：1 轮与 3 轮的差别远比 40 轮与 50 轮重要。
 */
export const TURNS_BUCKET_BOUNDS = [1, 2, 3, 5, 8, 13, 20, 30, 50] as const;

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
  batchSize: number; // 批量导出大小，默认 512
  flushIntervalMs: number; // 刷新间隔，默认 5000
  maxQueueSize: number; // 最大队列大小，默认 2048
}

export interface TelemetryExporterConfig {
  /**
   * 导出器类型。新增类型时必须同步四处，否则会被 createExporter 静默跳过：
   * `src/telemetry/index.ts` 的 createExporter、`src/config/config.ts` 的
   * TelemetryExporterConfig、`src/config/schema.ts` 的 VALID_EXPORTER_TYPES。
   */
  type: "console" | "jsonl" | "otlp";
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
  // 成本归因
  COST_USD: "sidcode.cost.usd",
  CACHE_SAVINGS_USD: "sidcode.cost.cache_savings_usd",
  // 预算管控
  BUDGET_REMAINING_USD: "sidcode.budget.remaining_usd",
  BUDGET_USAGE_PERCENT: "sidcode.budget.usage_percent",
  BUDGET_ALERT_LEVEL: "sidcode.budget.alert_level",
} as const;
