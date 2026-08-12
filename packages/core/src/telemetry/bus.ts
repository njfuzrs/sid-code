/**
 * 遥测总线——采集、缓冲、批量导出
 * 所有探针产生的数据都汇入总线，由总线负责批量处理和异步导出
 */

import type {
  SpanData,
  SpanEvent,
  SpanKind,
  SpanStatus,
  Attributes,
  AttributeValue,
  MetricPoint,
  TelemetryExporter,
  TelemetryConfig,
} from "./types.ts";
import { TraceContext, generateSpanId } from "./context.ts";
import { getLogger } from "../debug/logger.ts";

/** 活跃 Span 句柄——探针通过它记录数据 */
export class SpanHandle {
  private _startTime: number;
  private _attributes: Attributes = {};
  private _events: SpanEvent[] = [];
  private _status: SpanStatus = "unset";
  private _error?: { type: string; message: string; stack?: string };
  private _ended = false;

  constructor(
    private bus: TelemetryBus,
    private traceContext: TraceContext,
    readonly spanId: string,
    readonly parentSpanId: string | undefined,
    private _name: string,
    private _kind: SpanKind,
    initialAttributes?: Attributes,
  ) {
    this._startTime = Date.now();
    if (initialAttributes) this._attributes = { ...initialAttributes };
    traceContext.pushSpan(spanId);
  }

  /** 已经过的毫秒数（用于计算 TTFT 等） */
  elapsed(): number {
    return Date.now() - this._startTime;
  }

  /** 设置单个属性 */
  setAttribute(key: string, value: AttributeValue): this {
    this._attributes[key] = value;
    return this;
  }

  /** 批量设置属性 */
  setAttributes(attrs: Attributes): this {
    Object.assign(this._attributes, attrs);
    return this;
  }

  /** 添加事件 */
  addEvent(name: string, attributes?: Attributes): this {
    this._events.push({ name, timestamp: Date.now(), attributes });
    return this;
  }

  /** 记录错误 */
  recordError(err: unknown): this {
    this._status = "error";
    if (err instanceof Error) {
      this._error = { type: err.name, message: err.message, stack: err.stack };
    } else {
      this._error = { type: "Error", message: String(err) };
    }
    return this;
  }

  /** 结束 Span 并提交到总线 */
  end(finalAttributes?: Attributes): void {
    if (this._ended) return;
    this._ended = true;
    if (finalAttributes) Object.assign(this._attributes, finalAttributes);
    if (this._status === "unset") this._status = "ok";

    const endTime = Date.now();
    const spanData: SpanData = {
      traceId: this.traceContext.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this._name,
      kind: this._kind,
      status: this._status,
      startTime: this._startTime,
      endTime,
      durationMs: endTime - this._startTime,
      attributes: this._attributes,
      events: this._events,
      error: this._error,
    };

    this.traceContext.popSpan();
    this.bus.enqueueSpan(spanData);
  }
}

/** 默认配置 */
const DEFAULT_CONFIG: TelemetryConfig = {
  enabled: false,
  exporters: [],
  batchSize: 512,
  flushIntervalMs: 5000,
  maxQueueSize: 2048,
};

/** 会话内 span/metric 历史上限（防止长会话内存膨胀） */
const MAX_HISTORY_SPANS = 500;
const MAX_HISTORY_METRICS = 2000;

/** 遥测总线 */
export class TelemetryBus {
  private spanQueue: SpanData[] = [];
  private metricQueue: MetricPoint[] = [];
  private exporters: TelemetryExporter[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private config: TelemetryConfig;
  private traceContext?: TraceContext;
  private _shutdownRegistered = false;

  /** 会话内已完成的 span 历史（供 /telemetry 命令查询） */
  private spanHistory: SpanData[] = [];
  /** 会话内已记录的 metric 历史（供 /telemetry 命令查询） */
  private metricHistory: MetricPoint[] = [];

  constructor(config?: Partial<TelemetryConfig>) {
    // ⚠️ 双保险：对象展开时**显式存在的 undefined 键**会覆盖掉 DEFAULT_CONFIG 的值，
    // 所以三个数值字段必须再用 ?? 兜一次。只在 config.ts 侧剔除 undefined 治不了
    // 别的调用方直接 `new TelemetryBus({ batchSize: undefined })`。
    // 曾因此 splice(0, undefined) 恒空 + setInterval(fn, undefined) 退化 0ms，
    // 落盘 190MB 纯换行字节。见
    // docs/bugfixes/done/20260807-遥测落盘恒空-配置undefined覆盖默认值.md
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.config = {
      ...merged,
      batchSize: merged.batchSize ?? DEFAULT_CONFIG.batchSize,
      flushIntervalMs: merged.flushIntervalMs ?? DEFAULT_CONFIG.flushIntervalMs,
      maxQueueSize: merged.maxQueueSize ?? DEFAULT_CONFIG.maxQueueSize,
    };
  }

  /** 只读快照——供门禁测试断言合并后的数值字段（不暴露可变引用） */
  getConfigSnapshot(): Readonly<TelemetryConfig> {
    return { ...this.config };
  }

  /** 是否启用 */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** 注册导出器 */
  addExporter(exporter: TelemetryExporter): void {
    this.exporters.push(exporter);
  }

  /** 启动定时刷新 */
  start(): void {
    if (!this.config.enabled) return;
    // 防重复:已有定时器时先清理,避免重复 start() 泄漏 setInterval(LEAK-5)
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.config.flushIntervalMs);
    // 关闭交由统一的 graceful-shutdown 流程驱动(spec 17 §3.4):
    // 不再在此自行注册 SIGINT/SIGTERM,避免与 app.ts 的信号处理器、
    // graceful-shutdown 的 failsafe 重复触发 process.exit。
    // 仅保留 beforeExit 作为非信号退出路径(如事件循环排空)的兜底刷新。
    if (!this._shutdownRegistered) {
      this._shutdownRegistered = true;
      process.on("beforeExit", () => {
        this.shutdown().catch(() => {});
      });
    }
  }

  /** 开始一个新的 Trace（每次用户请求调用一次） */
  startTrace(): TraceContext {
    this.traceContext = new TraceContext();
    return this.traceContext;
  }

  /** 获取当前 Trace 上下文 */
  getTraceContext(): TraceContext | undefined {
    return this.traceContext;
  }

  /** 创建新 Span */
  startSpan(kind: SpanKind, name: string, attributes?: Attributes): SpanHandle {
    const ctx = this.traceContext;
    if (!ctx) {
      // 没有活跃 trace 时自动创建
      this.startTrace();
      return this.startSpan(kind, name, attributes);
    }

    const spanId = generateSpanId();
    const parentSpanId = ctx.currentSpanId;
    return new SpanHandle(this, ctx, spanId, parentSpanId, name, kind, attributes);
  }

  /** 记录 Metric 数据点 */
  recordMetric(point: MetricPoint): void {
    if (!this.config.enabled) return;

    // 保留到历史（供 /telemetry 命令查询）
    this.metricHistory.push(point);
    if (this.metricHistory.length > MAX_HISTORY_METRICS) {
      this.metricHistory.splice(0, this.metricHistory.length - MAX_HISTORY_METRICS);
    }

    this.metricQueue.push(point);
    if (this.metricQueue.length >= this.config.batchSize) {
      this.flushMetrics().catch(() => {});
    }
  }

  /** 将完成的 Span 加入队列（由 SpanHandle.end() 调用） */
  enqueueSpan(span: SpanData): void {
    if (!this.config.enabled) return;

    // 保留到历史（供 /telemetry 命令查询）
    this.spanHistory.push(span);
    if (this.spanHistory.length > MAX_HISTORY_SPANS) {
      this.spanHistory.splice(0, this.spanHistory.length - MAX_HISTORY_SPANS);
    }

    // 队列溢出：丢弃最旧的 10%
    if (this.spanQueue.length >= this.config.maxQueueSize) {
      const evictCount = Math.ceil(this.config.maxQueueSize * 0.1);
      this.spanQueue.splice(0, evictCount);
    }
    this.spanQueue.push(span);
    if (this.spanQueue.length >= this.config.batchSize) {
      this.flushSpans().catch(() => {});
    }
  }

  /** 刷新所有缓冲数据到导出器 */
  async flush(): Promise<void> {
    await Promise.all([this.flushSpans(), this.flushMetrics()]);
  }

  private async flushSpans(): Promise<void> {
    if (this.spanQueue.length === 0) return;
    const batch = this.spanQueue.splice(0, this.config.batchSize);
    await Promise.allSettled(
      this.exporters.map((e) =>
        e.exportSpans(batch).catch((err) => {
          getLogger().debug("TELEMETRY", `导出失败 (${e.name}): ${err}`);
        }),
      ),
    );
  }

  private async flushMetrics(): Promise<void> {
    if (this.metricQueue.length === 0) return;
    const batch = this.metricQueue.splice(0, this.config.batchSize);
    await Promise.allSettled(
      this.exporters
        .filter((e) => e.exportMetrics)
        .map((e) =>
          e.exportMetrics!(batch).catch((err) => {
            getLogger().debug("TELEMETRY", `指标导出失败 (${e.name}): ${err}`);
          }),
        ),
    );
  }

  /** 关闭总线，刷新剩余数据 */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();

    // Perfetto 追踪输出（spec 17 §6.2）：SID_CODE_PERFETTO_TRACE 启用时落盘
    try {
      const { isPerfettoEnabled, writePerfettoTrace } = await import("./perfetto.ts");
      if (isPerfettoEnabled() && this.spanHistory.length > 0) {
        const path = writePerfettoTrace(this.spanHistory);
        if (path) getLogger().debug("TELEMETRY", `Perfetto 追踪已写入: ${path}`);
      }
    } catch {
      // Perfetto 输出失败不影响关闭
    }

    await Promise.allSettled(this.exporters.map((e) => e.shutdown()));
  }

  /** 获取会话内所有已完成的 span（供 /telemetry 命令使用） */
  getCompletedSpans(): readonly SpanData[] {
    return this.spanHistory;
  }

  /** 获取会话内所有已记录的 metric（供 /telemetry 命令使用） */
  getCompletedMetrics(): readonly MetricPoint[] {
    return this.metricHistory;
  }
}
