/**
 * T12.6：验证 RetryTelemetry 事件正确写入 events.jsonl + Provider 聚合
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { TraceWriter } from "@sid-code/core/trace/writer.ts";
import { aggregateProviderStats } from "@sid-code/core/trace/digest.ts";

describe("T12: RetryTelemetry 事件落盘", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sid-t12-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writeRetryTelemetry 写入 events.jsonl", () => {
    const collector = new TraceCollector({ outputDir: tempDir, maxSessionsRetained: 10 });
    // 手动模拟初始化状态
    const sessionId = "test-session-001";
    (collector as any).initialized = true;
    (collector as any).metadata = { session_id: sessionId };
    (collector as any).writer = new TraceWriter(tempDir, sessionId);

    // 写入 retry 事件
    collector.writeRetryTelemetry({
      type: "retry",
      model: "deepseek-chat",
      provider: "openai",
      attempt: 2,
      delayMs: 3000,
      error: "ECONNRESET",
      phase: "connection",
    });

    // 写入 timeout 事件
    collector.writeRetryTelemetry({
      type: "stream_idle_timeout",
      model: "deepseek-chat",
      provider: "openai",
      timeoutMs: 90000,
    });

    // 验证 events.jsonl 已写入
    const eventsPath = join(tempDir, "sessions", sessionId, "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);

    const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const event1 = JSON.parse(lines[0]);
    expect(event1.event).toBe("RetryTelemetry");
    expect(event1.session_id).toBe(sessionId);
    expect(event1.data.type).toBe("retry");
    expect(event1.data.provider).toBe("openai");
    expect(event1.data.attempt).toBe(2);

    const event2 = JSON.parse(lines[1]);
    expect(event2.event).toBe("RetryTelemetry");
    expect(event2.data.type).toBe("stream_idle_timeout");
    expect(event2.data.timeoutMs).toBe(90000);
  });

  it("未初始化时 writeRetryTelemetry 静默忽略", () => {
    const collector = new TraceCollector({ outputDir: tempDir, maxSessionsRetained: 10 });
    // 不初始化，直接写
    expect(() => collector.writeRetryTelemetry({ type: "retry", model: "test" })).not.toThrow();
  });
});

describe("T12.5: Provider 维度聚合", () => {
  it("从 AfterModelRaw + RetryTelemetry 事件聚合 provider 统计", () => {
    const events = [
      {
        event: "AfterModelRaw",
        data: { provider: "openai", elapsed_ms: 5000, model: "deepseek-chat" },
      },
      {
        event: "AfterModelRaw",
        data: { provider: "openai", elapsed_ms: 3000, model: "deepseek-chat" },
      },
      {
        event: "AfterModelRaw",
        data: { provider: "anthropic", elapsed_ms: 2000, model: "claude-3.5-sonnet" },
      },
      {
        event: "RetryTelemetry",
        data: { type: "retry", provider: "openai", model: "deepseek-chat" },
      },
      {
        event: "RetryTelemetry",
        data: { type: "stream_idle_timeout", provider: "openai", model: "deepseek-chat" },
      },
    ];

    const stats = aggregateProviderStats(events);
    expect(stats.length).toBe(2);

    const openai = stats.find((s: { provider: string }) => s.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.requests).toBe(2);
    expect(openai!.retried).toBe(1);
    expect(openai!.timedOut).toBe(1);
    expect(openai!.avgLatencyMs).toBe(4000);

    const anthropic = stats.find((s: { provider: string }) => s.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.requests).toBe(1);
    expect(anthropic!.retried).toBe(0);
    expect(anthropic!.avgLatencyMs).toBe(2000);
  });

  it("超时率 > 10% 时标记 warning", () => {
    const events = [
      { event: "AfterModelRaw", data: { provider: "openai", elapsed_ms: 5000 } },
      { event: "AfterModelRaw", data: { provider: "openai", elapsed_ms: 3000 } },
      // 2 个请求中 1 个超时 = 50%
      { event: "RetryTelemetry", data: { type: "stream_idle_timeout", provider: "openai" } },
    ];

    const stats = aggregateProviderStats(events);
    const openai = stats.find((s: { provider: string }) => s.provider === "openai");
    expect(openai!.warning).toContain("超时率");
    expect(openai!.warning).toContain("> 10%");
  });
});
