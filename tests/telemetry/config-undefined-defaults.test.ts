/**
 * 门禁测试：**显式 undefined 必须不能击穿默认值**
 *
 * 钉住 2026-08-07 的 P0 形态（docs/bugfixes/todo/20260807-遥测落盘恒空-配置undefined覆盖默认值.md）：
 * `~/.sid-code/app.json` 只配了 { telemetry: { enabled, exporters } }，
 * config.ts 的转换器无条件写出 batchSize/flushIntervalMs/maxQueueSize 三个键 ⇒ 值为 undefined，
 * 到 TelemetryBus 的 `{ ...DEFAULT_CONFIG, ...config }` 里把 512/5000/2048 覆盖掉，于是：
 *   ① splice(0, undefined) 恒返回空数组 → 队列永不排空、exporter 收到空批次
 *   ② q.length >= undefined 恒 false  → 满批刷新失效
 *   ③ setInterval(fn, undefined)      → 间隔当 0ms，每秒 tick 数百次
 *   ④ [].join("\n") + "\n"            → 每次只写一个裸换行符（累积 190MB 纯 \n）
 *   ⑤ 驱逐判断失效                     → 队列无界增长
 *
 * 已有的 otlp-exporter / otlp-wiring 测试都**直接给 exporter 传非空数组**，
 * 正好绕过唯一会出错的那一环——所以这些断言必须打在配置合并这一层。
 */

import { describe, test, expect } from "bun:test";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import type { SpanData, MetricPoint, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";
import { JsonlExporter } from "@sid-code/core/telemetry/exporters/jsonl.ts";
import { normalizeConfigKeysForTest } from "@sid-code/core/config/config.ts";
import { tmpdir } from "os";
import { join } from "path";
import { readFile, rm, mkdtemp } from "fs/promises";

/** 收集 exporter 实际收到的批次（含空批次，用于断言"不该被调用"） */
function makeRecordingExporter() {
  const spanBatches: SpanData[][] = [];
  const metricBatches: MetricPoint[][] = [];
  const exporter: TelemetryExporter = {
    name: "recording",
    exportSpans: async (spans) => { spanBatches.push(spans); },
    exportMetrics: async (metrics) => { metricBatches.push(metrics); },
    shutdown: async () => {},
  };
  return { exporter, spanBatches, metricBatches };
}

/** 生产路径的真实形态：app.json 只配 enabled + exporters，三个数值字段是显式 undefined */
const CONFIG_WITH_EXPLICIT_UNDEFINED = {
  enabled: true,
  exporters: [{ type: "jsonl" as const }],
  batchSize: undefined,
  flushIntervalMs: undefined,
  maxQueueSize: undefined,
};

describe("TelemetryBus：显式 undefined 不得击穿默认值", () => {
  test("合并后三个数值字段必须是数字，而非 undefined", () => {
    const bus = new TelemetryBus(CONFIG_WITH_EXPLICIT_UNDEFINED as any);
    const cfg = bus.getConfigSnapshot();

    expect(typeof cfg.batchSize).toBe("number");
    expect(typeof cfg.flushIntervalMs).toBe("number");
    expect(typeof cfg.maxQueueSize).toBe("number");

    // 必须落到 DEFAULT_CONFIG 的值上
    expect(cfg.batchSize).toBe(512);
    expect(cfg.flushIntervalMs).toBe(5000);
    expect(cfg.maxQueueSize).toBe(2048);
  });

  test("flushIntervalMs 不得为 0/NaN——否则 setInterval 退化成忙轮询", () => {
    const bus = new TelemetryBus(CONFIG_WITH_EXPLICIT_UNDEFINED as any);
    const interval = bus.getConfigSnapshot().flushIntervalMs;

    expect(Number.isFinite(interval)).toBe(true);
    expect(interval).toBeGreaterThan(0);
  });

  test("flush() 后 exporter 收到非空 span 批次（本 bug 的核心判据）", async () => {
    const { exporter, spanBatches } = makeRecordingExporter();
    const bus = new TelemetryBus(CONFIG_WITH_EXPLICIT_UNDEFINED as any);
    bus.addExporter(exporter);

    bus.startTrace();
    for (let i = 0; i < 3; i++) {
      bus.startSpan("chat", `chat ${i}`).end();
    }

    await bus.flush();

    // 修复前：splice(0, undefined) 取出 0 条 ⇒ 这里会拿到 [[]]（一个空批次）
    expect(spanBatches).toHaveLength(1);
    expect(spanBatches[0]!.length).toBe(3);
    expect(spanBatches[0]!.map(s => s.name)).toEqual(["chat 0", "chat 1", "chat 2"]);

    await bus.shutdown();
  });

  test("flush() 后 exporter 收到非空 metric 批次", async () => {
    const { exporter, metricBatches } = makeRecordingExporter();
    const bus = new TelemetryBus(CONFIG_WITH_EXPLICIT_UNDEFINED as any);
    bus.addExporter(exporter);

    bus.recordMetric({
      name: "gen_ai.client.token.usage",
      value: 42,
      timestamp: 1_700_000_000_000,
      attributes: {},
      type: "counter",
    });

    await bus.flush();

    expect(metricBatches).toHaveLength(1);
    expect(metricBatches[0]!.length).toBe(1);
    expect(metricBatches[0]![0]!.name).toBe("gen_ai.client.token.usage");

    await bus.shutdown();
  });

  test("flush() 必须真正排空队列——不留下永不导出的残留", async () => {
    const { exporter, spanBatches } = makeRecordingExporter();
    const bus = new TelemetryBus(CONFIG_WITH_EXPLICIT_UNDEFINED as any);
    bus.addExporter(exporter);

    bus.startTrace();
    for (let i = 0; i < 4; i++) bus.startSpan("chat", `chat ${i}`).end();

    await bus.flush();
    const firstRound = spanBatches.length;
    // 队列已空：再 flush 一次不应产生任何新批次（flushSpans 有 length===0 早退）
    await bus.flush();
    expect(spanBatches.length).toBe(firstRound);

    await bus.shutdown();
  });

  test("队列驱逐仍然生效——maxQueueSize 未被 undefined 抹掉", async () => {
    const { exporter, spanBatches } = makeRecordingExporter();
    // batchSize 给大值避免中途自动 flush，只验驱逐
    const bus = new TelemetryBus({
      enabled: true,
      exporters: [],
      batchSize: 100_000,
      flushIntervalMs: undefined,
      maxQueueSize: undefined,
    } as any);
    bus.addExporter(exporter);

    bus.startTrace();
    // 入队 2500 条，超过默认 maxQueueSize=2048
    for (let i = 0; i < 2500; i++) bus.startSpan("chat", `chat ${i}`).end();

    await bus.flush();
    const total = spanBatches.reduce((n, b) => n + b.length, 0);

    // 修复前：一条不驱逐 ⇒ 2500
    expect(total).toBeLessThan(2500);
    expect(total).toBeGreaterThan(0);

    await bus.shutdown();
  });
});

describe("JsonlExporter：空批次不得写裸换行符", () => {
  test("exportSpans([]) 不产生任何字节", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sid-telemetry-empty-"));
    try {
      const exporter = new JsonlExporter({ outputDir: dir });
      await exporter.exportSpans([]);
      await exporter.exportMetrics!([]);

      // 文件根本不该被创建；即便被创建也必须是 0 字节
      for (const f of ["traces.jsonl", "metrics.jsonl"]) {
        let content = "";
        try { content = await readFile(join(dir, f), "utf-8"); } catch { continue; }
        expect(content).toBe("");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("非空批次照常写入，且非换行字节 > 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sid-telemetry-nonempty-"));
    try {
      const exporter = new JsonlExporter({ outputDir: dir });
      await exporter.exportSpans([{
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        name: "chat test",
        kind: "chat",
        status: "ok",
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_000_100,
        durationMs: 100,
        attributes: {},
        events: [],
      }]);

      const content = await readFile(join(dir, "traces.jsonl"), "utf-8");
      expect(content.replace(/\n/g, "").length).toBeGreaterThan(0);
      expect(JSON.parse(content.trim()).name).toBe("chat test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("config.ts 转换器：不得写出显式 undefined 键", () => {
  test("app.json 只配 enabled+exporters 时，三个数值键必须缺席", () => {
    const out = normalizeConfigKeysForTest({
      telemetry: { enabled: true, exporters: [{ type: "jsonl" }] },
    }) as any;

    // 注意：断言的是「键不存在」，不是「值不是 undefined」——
    // 显式存在的 undefined 键才是本 bug 的成因，`toBeUndefined()` 分不出这两者。
    const keys = Object.keys(out.telemetry);
    expect(keys).not.toContain("batchSize");
    expect(keys).not.toContain("flushIntervalMs");
    expect(keys).not.toContain("maxQueueSize");
    expect(out.telemetry.enabled).toBe(true);
    expect(out.telemetry.exporters).toEqual([{ type: "jsonl" }]);
  });

  test("显式配了数值时照常透传（snake_case 与 camelCase 都认）", () => {
    const snake = normalizeConfigKeysForTest({
      telemetry: {
        enabled: true, exporters: [],
        batch_size: 8, flush_interval_ms: 100, max_queue_size: 16,
      },
    }) as any;
    expect(snake.telemetry.batchSize).toBe(8);
    expect(snake.telemetry.flushIntervalMs).toBe(100);
    expect(snake.telemetry.maxQueueSize).toBe(16);

    const camel = normalizeConfigKeysForTest({
      telemetry: {
        enabled: true, exporters: [],
        batchSize: 9, flushIntervalMs: 200, maxQueueSize: 32,
      },
    }) as any;
    expect(camel.telemetry.batchSize).toBe(9);
    expect(camel.telemetry.flushIntervalMs).toBe(200);
    expect(camel.telemetry.maxQueueSize).toBe(32);
  });

  test("端到端：转换器输出直接喂 TelemetryBus，三个字段仍是数字", () => {
    const out = normalizeConfigKeysForTest({
      telemetry: { enabled: true, exporters: [{ type: "jsonl" }] },
    }) as any;
    const cfg = new TelemetryBus(out.telemetry).getConfigSnapshot();
    expect(cfg.batchSize).toBe(512);
    expect(cfg.flushIntervalMs).toBe(5000);
    expect(cfg.maxQueueSize).toBe(2048);
  });
});
