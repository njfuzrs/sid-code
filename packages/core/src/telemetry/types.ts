/**
 * 遥测核心类型定义
 * 遵循 OTel GenAI 语义约定的数据模型
 */

/** Span 状态 */
export type SpanStatus = "ok" | "error" | "unset";

/**
 * Span 类型——对应 OTel GenAI 的 operation.name
 *
 * ⚠️ **声明 5 类、生产只产出 3 类**（chat / execute_tool / invoke_agent）。
 * `blocked_on_user` 与 `hook_execution` 依赖的 4 个 hook 事件
 * （Before/AfterPermissionCheck、Before/AfterHookExecution）全仓**没有 fire 方法、
 * 没有 fire 点**，所以这两类 span 当前恒不产生（预留）。消费方不要据此做「等人耗时剥离」——
 * 工具确认等待目前仍混在 execute_tool 的时长里。接线后请同步删掉这里与
 * hook-probe.ts、hook/types.ts、perfetto.ts 的「预留」标注
 * （门禁：tests/telemetry/observability-p0-regression.test.ts）。
 */
export type SpanKind =
  | "invoke_agent" // Agent 调用（顶层 + 子代理）
  | "chat" // LLM 推理调用
  | "execute_tool" // 工具执行
  | "blocked_on_user" // 预留：恒不产生（依赖的权限检查事件无 fire 点）
  | "hook_execution"; // 预留：恒不产生（依赖的 Hook 执行事件无 fire 点）

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
  name: string; // 如 "gen_ai.client.inference.usage.input_tokens"
  value: number;
  timestamp: number;
  attributes: Attributes; // 维度标签
  type: "counter" | "histogram" | "gauge";
  /**
   * UCUM 单位（如 `"s"`、`"{token}"`），原样进 OTLP `Metric.unit`。
   * GenAI 语义约定对每个标准 metric 都规定了单位；缺了它，后端只能把秒和毫秒当同一个数。
   */
  unit?: string;
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
 * TTFT 直方图的桶边界（**秒**），取 OTel GenAI 语义约定
 * `gen_ai.client.operation.time_to_first_chunk` 的推荐值（SHOULD）。
 *
 * 之前用的是自定义毫秒边界（100ms…60s）。换成规范值的理由是**跨工具可比**：
 * 两个都按规范桶上报的 agent，放进同一个看板才能直接比分位，自定义边界只能各看各的。
 * 规范桶依然满足当初定边界的两条要求：
 * - 低端覆盖本地路由（`glm-5.3` 一类 <500ms）与 `deepseek-v4-pro` p50 3983ms 两端，
 *   否则一族全落首桶、另一族全落尾桶，分布图上看不出任何东西；
 * - 尾部到 81.92s，比原来的 60s 更长 —— 慢首字节实测有 102.8s 的样本
 *   （见 `agent/agentic-loop.ts` 的 P2-6 注释），"慢尾巴才是用户流失点"。
 */
export const TTFT_BUCKET_BOUNDS_S = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
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

/**
 * HITL 确认耗时直方图的桶边界（秒）。
 *
 * 低端 0.5s 区分「秒批」（用户就盯着屏幕）与「回来才批」；尾部到 300s =
 * 权限确认的默认超时，超时样本恰好是等得最久的那类，必须有自己的桶而不是溢出。
 */
export const HITL_WAIT_BUCKET_BOUNDS_S = [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300] as const;

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
  // 规范名是 cache_write（曾用 cache_creation，那是 Anthropic API 的字段名，不是 OTel 的）
  CACHE_WRITE_TOKENS: "gen_ai.usage.cache_write.input_tokens",
  REASONING_TOKENS: "gen_ai.usage.reasoning.output_tokens",
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
  /**
   * 缺陷 8：chat span 的首内容延迟（毫秒）。原先只写成 span event `gen_ai.first_token`，
   * 而 `/telemetry` 读的是这个属性名 ⇒ 属性零生产者、TTFT 行永不显示。现在两处都写。
   */
  TTFT_MS: "sidcode.ttft_ms",
  /**
   * 缺陷 11：invoke_agent（会话根 / 子代理）上的用量走**这组**属性，不再借用
   * `gen_ai.usage.*`。OTel 语义里 `gen_ai.usage.input_tokens` 是「这一次 LLM 调用」的输入，
   * 贴到一次 agent 调用上，外部后端按标准语义 sum 时会把会话级值与每轮值混在一起。
   *
   * 口径固定为 **flow**（逐次调用累加，provider 原始 input 口径，与 `total_cumulative_prompt_tokens`
   * 同源），与 `sidcode.total_cost_usd` 可比；**不放末次 stock** —— 同名属性两种口径正是缺陷 11。
   */
  AGENT_CUMULATIVE_INPUT_TOKENS: "sidcode.agent.cumulative_input_tokens",
  AGENT_OUTPUT_TOKENS: "sidcode.agent.output_tokens",
  AGENT_CUMULATIVE_CACHE_READ_TOKENS: "sidcode.agent.cumulative_cache_read_tokens",
  AGENT_CUMULATIVE_CACHE_WRITE_TOKENS: "sidcode.agent.cumulative_cache_write_tokens",
  // 成本归因
  COST_USD: "sidcode.cost.usd",
  CACHE_SAVINGS_USD: "sidcode.cost.cache_savings_usd",
  // 预算管控
  BUDGET_REMAINING_USD: "sidcode.budget.remaining_usd",
  BUDGET_USAGE_PERCENT: "sidcode.budget.usage_percent",
  BUDGET_ALERT_LEVEL: "sidcode.budget.alert_level",
} as const;
