/**
 * OTLP 出口测试（P0-2 / P0-3）
 *
 * 覆盖三件事：
 * 1. OTLP/JSON payload 形态（hex ID、纳秒时间戳、AnyValue 映射、枚举值）
 * 2. 标准 OTEL_* 环境变量解析与端点补全规则
 * 3. 白名单已拆开——`otlp` 类型不再被 createExporter / schema 静默跳过
 *
 * ⚠ 环境变量必须存原值再恢复，不能无条件 delete：`bun test` 同批多文件跑在同一进程，
 * 无条件删会把 preload 兜底一起抹掉（见 CLAUDE.md「测试约定」）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OtlpTelemetryExporter } from "@sid-code/core/telemetry/exporters/otlp.ts";
import type { SpanData, MetricPoint } from "@sid-code/core/telemetry/types.ts";

/** 需要在测试里改写的 OTEL_* 变量 */
const OTEL_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of OTEL_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  // 存原值恢复：原本 undefined 的才删，原本有值的还回去
  for (const k of OTEL_KEYS) {
    const original = savedEnv[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

function makeSpan(overrides: Partial<SpanData> = {}): SpanData {
  return {
    traceId: "5b8efff798038103d269b633813fc60c",
    spanId: "eee19b7ec3c1b174",
    name: "chat gpt-4",
    kind: "chat",
    status: "ok",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_500,
    durationMs: 1500,
    attributes: {},
    events: [],
    ...overrides,
  };
}

// ============================================================
// 端点解析：OTel 规范的 per-signal vs base 规则
// ============================================================
describe("OtlpTelemetryExporter 端点解析", () => {
  test("无任何配置时用默认端点并追加 signal 路径", () => {
    const e = new OtlpTelemetryExporter();
    expect(e.getEndpoints()).toEqual({
      traces: "http://localhost:4318/v1/traces",
      metrics: "http://localhost:4318/v1/metrics",
    });
  });

  test("基础端点（OTEL_EXPORTER_OTLP_ENDPOINT）会被追加 v1/traces 与 v1/metrics", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
    const e = new OtlpTelemetryExporter();
    expect(e.getEndpoints()).toEqual({
      traces: "http://collector:4318/v1/traces",
      metrics: "http://collector:4318/v1/metrics",
    });
  });

  test("基础端点带尾斜杠不会产生双斜杠", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/";
    const e = new OtlpTelemetryExporter();
    expect(e.getEndpoints().traces).toBe("http://collector:4318/v1/traces");
  });

  test("per-signal 端点原样使用，不追加路径（OTel 规范硬性要求）", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://base:4318";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://jaeger:4318/custom/traces";
    const e = new OtlpTelemetryExporter();
    expect(e.getEndpoints()).toEqual({
      // per-signal 覆盖 base，且不被追加 /v1/traces
      traces: "http://jaeger:4318/custom/traces",
      // metrics 无 per-signal，仍走 base + 路径
      metrics: "http://base:4318/v1/metrics",
    });
  });

  test("traces 与 metrics 端点可分设到不同后端", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://jaeger:4318/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://prometheus:9090/v1/metrics";
    const e = new OtlpTelemetryExporter();
    expect(e.getEndpoints()).toEqual({
      traces: "http://jaeger:4318/v1/traces",
      metrics: "http://prometheus:9090/v1/metrics",
    });
  });

  test("显式 options 优先于环境变量", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://from-env:4318";
    const e = new OtlpTelemetryExporter({ endpoint: "http://from-options:4318" });
    expect(e.getEndpoints().traces).toBe("http://from-options:4318/v1/traces");
  });
});

// ============================================================
// traces payload 形态
// ============================================================
describe("OtlpTelemetryExporter traces payload", () => {
  test("traceId / spanId 是 hex 字符串，不是 base64", () => {
    const e = new OtlpTelemetryExporter();
    const span = (e.buildTracesPayload([makeSpan()]) as any).resourceSpans[0].scopeSpans[0]
      .spans[0];
    expect(span.traceId).toBe("5b8efff798038103d269b633813fc60c");
    expect(span.spanId).toBe("eee19b7ec3c1b174");
    expect(/^[0-9a-f]{32}$/.test(span.traceId)).toBe(true);
    expect(/^[0-9a-f]{16}$/.test(span.spanId)).toBe(true);
  });

  test("时间戳是纳秒且不丢精度（必须走 BigInt）", () => {
    const e = new OtlpTelemetryExporter();
    const span = (e.buildTracesPayload([makeSpan()]) as any).resourceSpans[0].scopeSpans[0]
      .spans[0];
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(span.endTimeUnixNano).toBe("1700000001500000000");
    // 1.7e18 超过 MAX_SAFE_INTEGER，普通 number 乘法会丢精度
    expect(Number(span.startTimeUnixNano) > Number.MAX_SAFE_INTEGER).toBe(true);
  });

  test("无 parentSpanId 时不输出该字段（根 span）", () => {
    const e = new OtlpTelemetryExporter();
    const span = (e.buildTracesPayload([makeSpan()]) as any).resourceSpans[0].scopeSpans[0]
      .spans[0];
    expect("parentSpanId" in span).toBe(false);
  });

  test("有 parentSpanId 时透传，构成 span 树", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildTracesPayload([
      makeSpan({ spanId: "aaaaaaaaaaaaaaaa", kind: "invoke_agent" }),
      makeSpan({ spanId: "bbbbbbbbbbbbbbbb", parentSpanId: "aaaaaaaaaaaaaaaa", kind: "chat" }),
      makeSpan({
        spanId: "cccccccccccccccc",
        parentSpanId: "bbbbbbbbbbbbbbbb",
        kind: "execute_tool",
      }),
    ]) as any;
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s: any) => s.parentSpanId)).toEqual([
      undefined,
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    ]);
    // 同一 trace 下三个 span，聚合端可拼出 invoke_agent → chat → execute_tool
    expect(new Set(spans.map((s: any) => s.traceId)).size).toBe(1);
  });

  test("status 用 OTLP 枚举数值：unset=0 / ok=1 / error=2", () => {
    const e = new OtlpTelemetryExporter();
    const codes = (["unset", "ok", "error"] as const).map((status) => {
      const payload = e.buildTracesPayload([makeSpan({ status })]) as any;
      return payload.resourceSpans[0].scopeSpans[0].spans[0].status.code;
    });
    expect(codes).toEqual([0, 1, 2]);
  });

  test("chat 是 CLIENT(3)，其余是 INTERNAL(1)", () => {
    const e = new OtlpTelemetryExporter();
    const kindOf = (kind: SpanData["kind"]) =>
      (e.buildTracesPayload([makeSpan({ kind })]) as any).resourceSpans[0].scopeSpans[0].spans[0]
        .kind;
    expect(kindOf("chat")).toBe(3);
    expect(kindOf("invoke_agent")).toBe(1);
    expect(kindOf("execute_tool")).toBe(1);
    expect(kindOf("hook_execution")).toBe(1);
  });

  test("error 转成标准 exception.* 属性 + status.message", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildTracesPayload([
      makeSpan({
        status: "error",
        error: { type: "TypeError", message: "boom", stack: "at foo()" },
      }),
    ]) as any;
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.stringValue]));
    expect(attrs["exception.type"]).toBe("TypeError");
    expect(attrs["exception.message"]).toBe("boom");
    expect(attrs["exception.stacktrace"]).toBe("at foo()");
    expect(span.status).toEqual({ code: 2, message: "boom" });
  });

  test("AnyValue 映射覆盖各类型：整数走 intValue 字符串、小数走 doubleValue", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildTracesPayload([
      makeSpan({
        attributes: {
          "s.val": "text",
          "i.val": 42,
          "d.val": 1.5,
          "b.val": true,
          "arr.val": ["a", "b"],
        },
      }),
    ]) as any;
    const attrs = new Map<string, any>(
      payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: any) => [a.key, a.value]),
    );
    expect(attrs.get("s.val")).toEqual({ stringValue: "text" });
    // intValue 用字符串：protobuf JSON mapping 对 int64 的要求
    expect(attrs.get("i.val")).toEqual({ intValue: "42" });
    expect(attrs.get("d.val")).toEqual({ doubleValue: 1.5 });
    expect(attrs.get("b.val")).toEqual({ boolValue: true });
    expect(attrs.get("arr.val")).toEqual({
      arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] },
    });
  });

  test("span events 带纳秒时间戳与属性", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildTracesPayload([
      makeSpan({
        events: [
          { name: "first_content", timestamp: 1_700_000_000_500, attributes: { ttft_ms: 500 } },
        ],
      }),
    ]) as any;
    const ev = payload.resourceSpans[0].scopeSpans[0].spans[0].events[0];
    expect(ev.name).toBe("first_content");
    expect(ev.timeUnixNano).toBe("1700000000500000000");
    expect(ev.attributes).toEqual([{ key: "ttft_ms", value: { intValue: "500" } }]);
  });

  test("resource 带 service.name，且可由 OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES 定制", () => {
    process.env.OTEL_SERVICE_NAME = "sid-code-prod";
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=staging,team=infra";
    const e = new OtlpTelemetryExporter();
    const payload = e.buildTracesPayload([makeSpan()]) as any;
    const attrs = Object.fromEntries(
      payload.resourceSpans[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue]),
    );
    expect(attrs["service.name"]).toBe("sid-code-prod");
    expect(attrs["deployment.environment"]).toBe("staging");
    expect(attrs["team"]).toBe("infra");
  });

  test("默认 service.name 是 sid-code", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildTracesPayload([makeSpan()]) as any;
    expect(payload.resourceSpans[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "sid-code" } },
    ]);
  });
});

// ============================================================
// metrics payload 形态
// ============================================================
describe("OtlpTelemetryExporter metrics payload", () => {
  const point = (overrides: Partial<MetricPoint> = {}): MetricPoint => ({
    name: "gen_ai.client.token.usage",
    value: 1024,
    timestamp: 1_700_000_000_000,
    attributes: { "gen_ai.request.model": "gpt-4" },
    type: "counter",
    ...overrides,
  });

  test("counter 走 sum + delta 时序 + isMonotonic", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildMetricsPayload([point()]) as any;
    const metric = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe("gen_ai.client.token.usage");
    // AGGREGATION_TEMPORALITY_DELTA=1：我们每次上报的是增量而非累计值
    expect(metric.sum.aggregationTemporality).toBe(1);
    expect(metric.sum.isMonotonic).toBe(true);
    expect(metric.sum.dataPoints[0].asDouble).toBe(1024);
    expect(metric.sum.dataPoints[0].timeUnixNano).toBe("1700000000000000000");
  });

  test("gauge 走 gauge", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildMetricsPayload([point({ type: "gauge" })]) as any;
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge).toBeDefined();
  });

  test("histogram 按 gauge 上报（MetricPoint 无分桶数据，硬造边界会得出错误分布）", () => {
    const e = new OtlpTelemetryExporter();
    const metric = (e.buildMetricsPayload([point({ type: "histogram" })]) as any).resourceMetrics[0]
      .scopeMetrics[0].metrics[0];
    expect(metric.gauge).toBeDefined();
    expect(metric.histogram).toBeUndefined();
  });

  test("同名 metric 合并为一个 Metric 条目下的多个 data point", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildMetricsPayload([
      point({ attributes: { "gen_ai.token.type": "input" }, value: 100 }),
      point({ attributes: { "gen_ai.token.type": "output" }, value: 20 }),
      point({ name: "sidcode.cost.usd", value: 0.42 }),
    ]) as any;
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(2);
    expect(metrics[0].name).toBe("gen_ai.client.token.usage");
    expect(metrics[0].sum.dataPoints).toHaveLength(2);
    expect(metrics[1].name).toBe("sidcode.cost.usd");
    expect(metrics[1].sum.dataPoints[0].asDouble).toBe(0.42);
  });

  test("维度标签落到 data point 的 attributes", () => {
    const e = new OtlpTelemetryExporter();
    const payload = e.buildMetricsPayload([
      point({ attributes: { "gen_ai.request.model": "gpt-4", "gen_ai.token.type": "input" } }),
    ]) as any;
    const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    expect(dp.attributes).toEqual([
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4" } },
      { key: "gen_ai.token.type", value: { stringValue: "input" } },
    ]);
  });
});

// ============================================================
// HTTP 发送行为
// ============================================================
describe("OtlpTelemetryExporter HTTP 发送", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POST 到 traces 端点，带 Content-Type 与自定义头", async () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer tok,x-tenant=acme";
    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as any;

    const e = new OtlpTelemetryExporter({ endpoint: "http://collector:4318" });
    await e.exportSpans([makeSpan()]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector:4318/v1/traces");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["Content-Type"]).toBe("application/json");
    // 值里含空格与 `=` 也要能正确解析（只按第一个 `=` 切分）
    expect(calls[0]!.init.headers["authorization"]).toBe("Bearer tok");
    expect(calls[0]!.init.headers["x-tenant"]).toBe("acme");
    // body 必须是合法 JSON
    expect(() => JSON.parse(calls[0]!.init.body)).not.toThrow();
  });

  test("metrics 走 metrics 端点", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as any;

    const e = new OtlpTelemetryExporter({ endpoint: "http://collector:4318" });
    await e.exportMetrics([
      {
        name: "sidcode.cost.usd",
        value: 0.1,
        timestamp: 1_700_000_000_000,
        attributes: {},
        type: "counter",
      },
    ]);
    expect(urls).toEqual(["http://collector:4318/v1/metrics"]);
  });

  test("空数组不发请求", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as any;

    const e = new OtlpTelemetryExporter();
    await e.exportSpans([]);
    await e.exportMetrics([]);
    expect(called).toBe(0);
  });

  test("非 2xx 抛错（由 TelemetryBus 的 catch 兜住，不阻塞主流程）", async () => {
    globalThis.fetch = (async () =>
      new Response("bad request", { status: 400, statusText: "Bad Request" })) as any;

    const e = new OtlpTelemetryExporter();
    // 显式 try/catch 而非 expect().rejects：后者在此处的类型下 await 不生效，
    // 断言可能根本没被等到就通过（空过）。
    let caught: unknown;
    try {
      await e.exportSpans([makeSpan()]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/OTLP HTTP 400/);
  });
});
