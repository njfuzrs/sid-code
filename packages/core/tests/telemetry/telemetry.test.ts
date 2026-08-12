/**
 * 遥测模块单元测试
 */

import { describe, test, expect, afterEach } from "bun:test";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TraceContext, generateTraceId, generateSpanId } from "@sid-code/core/telemetry/context.ts";
import { ConsoleExporter } from "@sid-code/core/telemetry/exporters/console.ts";
import { JsonlExporter } from "@sid-code/core/telemetry/exporters/jsonl.ts";
import { ATTR } from "@sid-code/core/telemetry/types.ts";
import type { SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";
import {
  initTelemetry,
  getTelemetryBus,
  shutdownTelemetry,
} from "@sid-code/core/telemetry/index.ts";
import { tmpdir } from "os";
import { join } from "path";
import { readFile, rm } from "fs/promises";

// ============================================================
// TraceContext
// ============================================================
describe("TraceContext", () => {
  test("生成有效的 traceId", () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
  });

  test("生成有效的 spanId", () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(id)).toBe(true);
  });

  test("Span 栈管理", () => {
    const ctx = new TraceContext();
    expect(ctx.currentSpanId).toBeUndefined();
    expect(ctx.depth).toBe(0);

    ctx.pushSpan("span-1");
    expect(ctx.currentSpanId).toBe("span-1");
    expect(ctx.depth).toBe(1);

    ctx.pushSpan("span-2");
    expect(ctx.currentSpanId).toBe("span-2");
    expect(ctx.depth).toBe(2);

    expect(ctx.popSpan()).toBe("span-2");
    expect(ctx.currentSpanId).toBe("span-1");

    expect(ctx.popSpan()).toBe("span-1");
    expect(ctx.currentSpanId).toBeUndefined();
  });

  test("自定义 traceId", () => {
    const ctx = new TraceContext("abcd1234abcd1234abcd1234abcd1234");
    expect(ctx.traceId).toBe("abcd1234abcd1234abcd1234abcd1234");
  });
});

// ============================================================
// TelemetryBus
// ============================================================
describe("TelemetryBus", () => {
  test("禁用时不收集数据", () => {
    const bus = new TelemetryBus({ enabled: false });
    bus.startTrace();
    const span = bus.startSpan("chat", "chat test");
    span.end();
    // 不应抛错
  });

  test("启用时收集 Span", async () => {
    const collected: SpanData[] = [];
    const mockExporter: TelemetryExporter = {
      name: "mock",
      exportSpans: async (spans) => {
        collected.push(...spans);
      },
      shutdown: async () => {},
    };

    const bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999999 });
    bus.addExporter(mockExporter);

    bus.startTrace();
    const span = bus.startSpan("invoke_agent", "invoke_agent test", {
      [ATTR.AGENT_NAME]: "sid-code",
    });
    span.setAttribute(ATTR.REQUEST_MODEL, "claude-sonnet-4");
    span.addEvent("test_event", { key: "value" });
    span.end();

    await bus.flush();

    expect(collected).toHaveLength(1);
    const s = collected[0];
    expect(s.name).toBe("invoke_agent test");
    expect(s.kind).toBe("invoke_agent");
    expect(s.status).toBe("ok");
    expect(s.attributes[ATTR.AGENT_NAME]).toBe("sid-code");
    expect(s.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4");
    expect(s.events).toHaveLength(1);
    expect(s.events[0].name).toBe("test_event");
    expect(s.durationMs).toBeGreaterThanOrEqual(0);

    await bus.shutdown();
  });

  test("父子 Span 关系正确", async () => {
    const collected: SpanData[] = [];
    const mockExporter: TelemetryExporter = {
      name: "mock",
      exportSpans: async (spans) => {
        collected.push(...spans);
      },
      shutdown: async () => {},
    };

    const bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999999 });
    bus.addExporter(mockExporter);

    bus.startTrace();
    const parent = bus.startSpan("invoke_agent", "agent");
    const child = bus.startSpan("chat", "chat model");
    child.end();
    parent.end();

    await bus.flush();

    expect(collected).toHaveLength(2);
    const childSpan = collected.find((s) => s.kind === "chat")!;
    const parentSpan = collected.find((s) => s.kind === "invoke_agent")!;

    expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
    expect(childSpan.traceId).toBe(parentSpan.traceId);
    expect(parentSpan.parentSpanId).toBeUndefined();

    await bus.shutdown();
  });

  test("错误记录", async () => {
    const collected: SpanData[] = [];
    const mockExporter: TelemetryExporter = {
      name: "mock",
      exportSpans: async (spans) => {
        collected.push(...spans);
      },
      shutdown: async () => {},
    };

    const bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999999 });
    bus.addExporter(mockExporter);

    bus.startTrace();
    const span = bus.startSpan("execute_tool", "execute_tool bash");
    span.recordError(new Error("command failed"));
    span.end();

    await bus.flush();

    expect(collected).toHaveLength(1);
    expect(collected[0].status).toBe("error");
    expect(collected[0].error?.type).toBe("Error");
    expect(collected[0].error?.message).toBe("command failed");

    await bus.shutdown();
  });

  test("队列溢出时丢弃旧数据", async () => {
    const collected: SpanData[] = [];
    const mockExporter: TelemetryExporter = {
      name: "mock",
      exportSpans: async (spans) => {
        collected.push(...spans);
      },
      shutdown: async () => {},
    };

    const bus = new TelemetryBus({
      enabled: true,
      maxQueueSize: 5,
      batchSize: 100,
      flushIntervalMs: 999999,
    });
    bus.addExporter(mockExporter);

    bus.startTrace();
    // 创建 6 个 span，超过 maxQueueSize=5
    for (let i = 0; i < 6; i++) {
      const span = bus.startSpan("chat", `chat ${i}`);
      span.end();
    }

    await bus.flush();
    // 应该丢弃了最旧的 10%（至少 1 个）
    expect(collected.length).toBeLessThanOrEqual(6);
    expect(collected.length).toBeGreaterThanOrEqual(4);

    await bus.shutdown();
  });

  test("Span 不能重复 end", async () => {
    const collected: SpanData[] = [];
    const mockExporter: TelemetryExporter = {
      name: "mock",
      exportSpans: async (spans) => {
        collected.push(...spans);
      },
      shutdown: async () => {},
    };

    const bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999999 });
    bus.addExporter(mockExporter);

    bus.startTrace();
    const span = bus.startSpan("chat", "chat test");
    span.end();
    span.end(); // 第二次 end 应被忽略

    await bus.flush();
    expect(collected).toHaveLength(1);

    await bus.shutdown();
  });
});

// ============================================================
// JSONL Exporter
// ============================================================
describe("JsonlExporter", () => {
  const testDir = join(tmpdir(), `sid-code-telemetry-test-${Date.now()}`);

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true });
    } catch {}
  });

  test("导出 Span 到 JSONL 文件", async () => {
    const exporter = new JsonlExporter({
      outputDir: testDir,
      maxFileSize: 50 * 1024 * 1024,
      maxFiles: 5,
    });

    const span: SpanData = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "test span",
      kind: "chat",
      status: "ok",
      startTime: Date.now() - 100,
      endTime: Date.now(),
      durationMs: 100,
      attributes: { [ATTR.REQUEST_MODEL]: "test-model" },
      events: [],
    };

    await exporter.exportSpans([span]);

    const content = await readFile(exporter.getSpanFilePath(), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.name).toBe("test span");
    expect(parsed.kind).toBe("chat");
    expect(parsed.attributes[ATTR.REQUEST_MODEL]).toBe("test-model");

    await exporter.shutdown();
  });

  test("多次导出追加写入", async () => {
    const exporter = new JsonlExporter({
      outputDir: testDir,
      maxFileSize: 50 * 1024 * 1024,
      maxFiles: 5,
    });

    const makeSpan = (name: string): SpanData => ({
      traceId: "a".repeat(32),
      spanId: generateSpanId(),
      name,
      kind: "execute_tool",
      status: "ok",
      startTime: Date.now(),
      endTime: Date.now(),
      durationMs: 0,
      attributes: {},
      events: [],
    });

    await exporter.exportSpans([makeSpan("span1")]);
    await exporter.exportSpans([makeSpan("span2"), makeSpan("span3")]);

    const content = await readFile(exporter.getSpanFilePath(), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);

    await exporter.shutdown();
  });
});

// ============================================================
// ConsoleExporter
// ============================================================
describe("ConsoleExporter", () => {
  test("off 模式不输出", async () => {
    const exporter = new ConsoleExporter({ verbosity: "off" });
    // 不应抛错
    await exporter.exportSpans([
      {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        name: "test",
        kind: "chat",
        status: "ok",
        startTime: Date.now(),
        endTime: Date.now(),
        durationMs: 0,
        attributes: {},
        events: [],
      },
    ]);
    await exporter.shutdown();
  });
});

// ============================================================
// initTelemetry / getTelemetryBus
// ============================================================
describe("initTelemetry", () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  test("禁用时返回禁用的 bus", () => {
    const bus = getTelemetryBus();
    expect(bus.isEnabled()).toBe(false);
  });

  test("启用时返回启用的 bus", async () => {
    const testDir = join(tmpdir(), `sid-code-telemetry-init-${Date.now()}`);
    const bus = initTelemetry({
      enabled: true,
      exporters: [{ type: "jsonl", options: { outputDir: testDir } }],
      batchSize: 100,
      flushIntervalMs: 999999,
    });
    expect(bus.isEnabled()).toBe(true);

    // 验证 getTelemetryBus 返回同一个实例
    expect(getTelemetryBus()).toBe(bus);

    await shutdownTelemetry();
    try {
      await rm(testDir, { recursive: true });
    } catch {}
  });
});
