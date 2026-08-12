/**
 * OTLP/HTTP 导出器——把 span / metric 送进客户自有的 OTel 栈
 *
 * 对应 P0-2（`docs/bugfixes/todo/20260805-可观测性缺陷清单-埋点接线与OTLP出口.md`）。
 * 在此之前 telemetry 的出口白名单只有 console / jsonl，数据模型虽已对齐 OTel GenAI
 * 语义约定，但只能落本地文件——企业要的是 span 进他们的 Jaeger / Datadog / Grafana。
 *
 * 零依赖实现：直接发 OTLP/HTTP + JSON（protobuf JSON mapping），不引入
 * `@opentelemetry/*` 任何包。JSON 编码是 OTLP 规范的一等公民，collector 原生接受。
 *
 * 两个编码细节是 OTLP/JSON 的坑，写错就是 collector 静默拒收：
 * 1. `traceId` / `spanId` 用**十六进制字符串**，不是标准 protobuf JSON mapping 的
 *    base64（OTLP 规范对这两个字段专门开了例外）。
 * 2. 键名一律 lowerCamelCase（`droppedAttributesCount`，不是 `dropped_attributes_count`）。
 */

import type {
  SpanData,
  MetricPoint,
  TelemetryExporter,
  Attributes,
  AttributeValue,
} from "../types.ts";

/** OTLP 默认端点（与 OTel SDK 一致） */
const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

export interface OtlpTelemetryExporterOptions {
  /**
   * 基础端点。按 OTel 规范，基础端点会被追加 `/v1/traces`、`/v1/metrics`。
   * 优先级：显式 options > OTEL_EXPORTER_OTLP_ENDPOINT > http://localhost:4318
   */
  endpoint?: string;
  /**
   * traces 专用端点。按 OTel 规范，**per-signal 端点原样使用、不追加路径**。
   * 优先级：显式 options > OTEL_EXPORTER_OTLP_TRACES_ENDPOINT > 基础端点 + /v1/traces
   */
  tracesEndpoint?: string;
  /** metrics 专用端点，语义同 tracesEndpoint（对应 OTEL_EXPORTER_OTLP_METRICS_ENDPOINT） */
  metricsEndpoint?: string;
  /**
   * 附加请求头。合并顺序：OTEL_EXPORTER_OTLP_HEADERS < 本字段
   * （显式配置覆盖环境变量，便于在 settings.json 里为单个后端定制）
   */
  headers?: Record<string, string>;
  /** 请求超时（ms），对应 OTEL_EXPORTER_OTLP_TIMEOUT，默认 10000 */
  timeoutMs?: number;
  /** service.name 资源属性，对应 OTEL_SERVICE_NAME，默认 "sid-code" */
  serviceName?: string;
  /** 额外资源属性，对应 OTEL_RESOURCE_ATTRIBUTES */
  resourceAttributes?: Attributes;
}

/** 解析 `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_RESOURCE_ATTRIBUTES` 的 W3C Baggage 式列表 */
function parseKeyValueList(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (!key) continue;
    // 值里可能含 `=`（如 base64 认证头），只按第一个 `=` 切分
    out[key] = pair.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 按 OTel 规范拼接 signal 端点。
 *
 * - per-signal 变量：原样使用，路径由用户负责（唯一例外是无 path 时补 `/`）
 * - 基础变量：追加 `v1/traces` / `v1/metrics`
 */
function resolveSignalEndpoint(
  explicitSignal: string | undefined,
  envSignal: string | undefined,
  base: string,
  signalPath: "v1/traces" | "v1/metrics",
): string {
  const perSignal = explicitSignal ?? envSignal;
  if (perSignal && perSignal.trim()) {
    const url = perSignal.trim();
    try {
      const parsed = new URL(url);
      // 规范：URL 无 path 部分时用根路径 `/`
      return parsed.pathname === "" ? `${url}/` : url;
    } catch {
      return url; // 非法 URL 交给 fetch 报错，不在这里吞掉
    }
  }
  return `${base.replace(/\/+$/, "")}/${signalPath}`;
}

/** SpanKind → OTLP `span.kind` 枚举。我们的 kind 语义是 GenAI operation，非 RPC 角色 */
function toOtlpSpanKind(kind: SpanData["kind"]): number {
  // SPAN_KIND_CLIENT=3：向外部服务（LLM provider）发起调用
  // SPAN_KIND_INTERNAL=1：进程内部操作
  switch (kind) {
    case "chat":
      return 3;
    case "invoke_agent":
    case "execute_tool":
    case "blocked_on_user":
    case "hook_execution":
      return 1;
    default:
      return 1;
  }
}

/** SpanStatus → OTLP StatusCode 枚举（UNSET=0 / OK=1 / ERROR=2） */
function toOtlpStatusCode(status: SpanData["status"]): number {
  switch (status) {
    case "ok":
      return 1;
    case "error":
      return 2;
    default:
      return 0;
  }
}

/**
 * Unix 毫秒 → OTLP 纳秒字符串。
 *
 * 必须走 BigInt：`ms * 1e6` 的结果量级是 1.7e18，远超
 * `Number.MAX_SAFE_INTEGER`（9.0e15），用普通乘法末几位会静默丢精度。
 */
function toUnixNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/** AttributeValue → OTLP AnyValue */
function toAnyValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((v) => toAnyValue(v as AttributeValue)),
      },
    };
  }
  return { stringValue: String(value) };
}

/** Attributes → OTLP KeyValue[] */
function toKeyValues(attrs: Attributes | undefined): Array<Record<string, unknown>> {
  if (!attrs) return [];
  return Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

export class OtlpTelemetryExporter implements TelemetryExporter {
  readonly name = "otlp";

  private readonly tracesEndpoint: string;
  private readonly metricsEndpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly resourceAttributes: Attributes;

  constructor(options: OtlpTelemetryExporterOptions = {}) {
    const env = process.env;
    const base = options.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT;

    this.tracesEndpoint = resolveSignalEndpoint(
      options.tracesEndpoint,
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      base,
      "v1/traces",
    );
    this.metricsEndpoint = resolveSignalEndpoint(
      options.metricsEndpoint,
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      base,
      "v1/metrics",
    );

    this.headers = {
      ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...(options.headers ?? {}),
    };

    const envTimeout = Number(env.OTEL_EXPORTER_OTLP_TIMEOUT);
    this.timeoutMs =
      options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 10_000);

    const serviceName = options.serviceName ?? env.OTEL_SERVICE_NAME ?? "sid-code";
    this.resourceAttributes = {
      "service.name": serviceName,
      ...parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES),
      ...(options.resourceAttributes ?? {}),
    };
  }

  /** 供测试与排查用：确认端点解析结果 */
  getEndpoints(): { traces: string; metrics: string } {
    return { traces: this.tracesEndpoint, metrics: this.metricsEndpoint };
  }

  async exportSpans(spans: SpanData[]): Promise<void> {
    if (spans.length === 0) return;
    await this.post(this.tracesEndpoint, this.buildTracesPayload(spans));
  }

  async exportMetrics(metrics: MetricPoint[]): Promise<void> {
    if (metrics.length === 0) return;
    await this.post(this.metricsEndpoint, this.buildMetricsPayload(metrics));
  }

  async shutdown(): Promise<void> {
    // 无本地缓冲：批量由 TelemetryBus 负责，此处无待刷新状态
  }

  /** 构造 OTLP ExportTraceServiceRequest */
  buildTracesPayload(spans: SpanData[]): Record<string, unknown> {
    return {
      resourceSpans: [
        {
          resource: { attributes: toKeyValues(this.resourceAttributes) },
          scopeSpans: [
            {
              scope: { name: "sid-code.telemetry" },
              spans: spans.map((s) => this.toOtlpSpan(s)),
            },
          ],
        },
      ],
    };
  }

  private toOtlpSpan(span: SpanData): Record<string, unknown> {
    const attributes = toKeyValues(span.attributes);
    // 错误详情按 OTel 语义约定放进属性（exception.* 是标准键名）
    if (span.error) {
      attributes.push({ key: "exception.type", value: { stringValue: span.error.type } });
      attributes.push({ key: "exception.message", value: { stringValue: span.error.message } });
      if (span.error.stack) {
        attributes.push({
          key: "exception.stacktrace",
          value: { stringValue: span.error.stack },
        });
      }
    }

    const status: Record<string, unknown> = { code: toOtlpStatusCode(span.status) };
    if (span.status === "error" && span.error) status.message = span.error.message;

    return {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      kind: toOtlpSpanKind(span.kind),
      startTimeUnixNano: toUnixNano(span.startTime),
      endTimeUnixNano: toUnixNano(span.endTime),
      attributes,
      events: span.events.map((e) => ({
        timeUnixNano: toUnixNano(e.timestamp),
        name: e.name,
        attributes: toKeyValues(e.attributes),
      })),
      status,
    };
  }

  /** 构造 OTLP ExportMetricsServiceRequest */
  buildMetricsPayload(metrics: MetricPoint[]): Record<string, unknown> {
    // 同名 metric 合并到一个 Metric 条目下（OTLP 语义：一个 Metric 多个 data point）
    const byName = new Map<string, MetricPoint[]>();
    for (const m of metrics) {
      const list = byName.get(m.name);
      if (list) list.push(m);
      else byName.set(m.name, [m]);
    }

    return {
      resourceMetrics: [
        {
          resource: { attributes: toKeyValues(this.resourceAttributes) },
          scopeMetrics: [
            {
              scope: { name: "sid-code.telemetry" },
              metrics: Array.from(byName, ([name, points]) => this.toOtlpMetric(name, points)),
            },
          ],
        },
      ],
    };
  }

  private toOtlpMetric(name: string, points: MetricPoint[]): Record<string, unknown> {
    const dataPoints = points.map((p) => ({
      attributes: toKeyValues(p.attributes),
      // 单点上报没有独立的窗口起点，start 与 end 同值（OTLP 允许）
      startTimeUnixNano: toUnixNano(p.timestamp),
      timeUnixNano: toUnixNano(p.timestamp),
      asDouble: p.value,
    }));

    // 同名 metric 的 type 取首个点为准（同名混用 type 是上游 bug，不在此处兜）
    const type = points[0]?.type ?? "gauge";

    if (type === "counter") {
      return {
        name,
        sum: {
          dataPoints,
          // AGGREGATION_TEMPORALITY_DELTA=1：每次上报是增量，不是累计值
          aggregationTemporality: 1,
          isMonotonic: true,
        },
      };
    }

    if (type === "histogram") {
      // 我们的 MetricPoint 只带单值、无分桶。硬造分桶边界会得出错误的分布，
      // 所以按 gauge 上报——形态诚实，聚合端可自行做直方图。
      return { name, gauge: { dataPoints } };
    }

    return { name, gauge: { dataPoints } };
  }

  private async post(url: string, payload: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OTLP HTTP ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
