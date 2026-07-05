/**
 * T15.6：Provider 健康度聚合单测
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateProviderHealth, renderHealthText } from "../../src/telemetry/provider-health.ts";

describe("T15: Provider 健康度聚合", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sid-t15-"));
    sessionsDir = join(tempDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSession(sessionId: string, events: object[]): void {
    const dir = join(sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const content = events.map(e => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(dir, "events.jsonl"), content);
  }

  it("从多个会话聚合 provider 健康指标", () => {
    const now = new Date().toISOString();
    writeSession("session-001", [
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 5000, ttft_ms: 2000, model: "deepseek" } },
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 3000, ttft_ms: 1000, model: "deepseek" } },
      { event: "AfterModelRaw", timestamp: now, data: { provider: "anthropic", elapsed_ms: 2000, ttft_ms: 800, model: "claude" } },
    ]);
    writeSession("session-002", [
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 4000, ttft_ms: 1500, model: "deepseek" } },
      { event: "RetryTelemetry", timestamp: now, data: { type: "retry", provider: "openai", model: "deepseek" } },
      { event: "RetryTelemetry", timestamp: now, data: { type: "stream_idle_timeout", provider: "openai" } },
    ]);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });

    expect(report.providers.length).toBe(2);

    const openai = report.providers.find(p => p.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.requests.total).toBe(3);
    expect(openai!.requests.retried).toBe(1);
    expect(openai!.requests.timedOut).toBe(1);
    // TTFT P50: 排序后 [1000, 1500, 2000]，P50 = 1500
    expect(openai!.latency.ttft_p50).toBe(1500);
    // TTFT P95: [1000, 1500, 2000]，P95 = index ceil(3*0.95)-1 = 2 → 2000
    expect(openai!.latency.ttft_p95).toBe(2000);

    const anthropic = report.providers.find(p => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.requests.total).toBe(1);
    expect(anthropic!.latency.ttft_p50).toBe(800);
  });

  it("按 provider 过滤", () => {
    const now = new Date().toISOString();
    writeSession("session-003", [
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 3000 } },
      { event: "AfterModelRaw", timestamp: now, data: { provider: "anthropic", elapsed_ms: 2000 } },
    ]);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir, provider: "anthropic" });
    expect(report.providers.length).toBe(1);
    expect(report.providers[0].provider).toBe("anthropic");
    expect(report.providers[0].requests.total).toBe(1);
  });

  it("成功率 < 95% 时生成 warning 告警", () => {
    const now = new Date().toISOString();
    // 10 个请求中 1 个超时 = 90% 成功率
    const events: object[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 3000 } });
    }
    events.push({ event: "RetryTelemetry", timestamp: now, data: { type: "stream_idle_timeout", provider: "openai" } });

    writeSession("session-004", events);
    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });

    const openai = report.providers.find(p => p.provider === "openai");
    expect(openai!.requests.timedOut).toBe(1);
    // 成功率 = (10-0-1)/10 = 90% < 95% → warning
    expect(report.alerts.length).toBeGreaterThan(0);
    expect(report.alerts.some(a => a.severity === "warning" && a.message.includes("成功率"))).toBe(true);
  });

  it("无数据时返回空报告", () => {
    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    expect(report.providers.length).toBe(0);
    expect(report.alerts.length).toBe(0);
  });

  it("P50/P95/P99 计算精度", () => {
    const now = new Date().toISOString();
    // 构造 100 个请求，TTFT 从 100 到 10000
    const events: object[] = [];
    for (let i = 1; i <= 100; i++) {
      events.push({ event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: i * 100, ttft_ms: i * 100 } });
    }
    writeSession("session-005", events);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    const openai = report.providers.find(p => p.provider === "openai");
    expect(openai).toBeDefined();
    // P50 ~ 5000 (index 49)
    expect(openai!.latency.ttft_p50).toBe(5000);
    // P95 ~ 9500 (index 94)
    expect(openai!.latency.ttft_p95).toBe(9500);
    // P99 ~ 9900 (index 98)
    expect(openai!.latency.ttft_p99).toBe(9900);
  });

  // T15.5：/trace --health 复用的纯文本渲染器
  it("renderHealthText: 纯文本看板含 provider/成功率, 无 ANSI 码", () => {
    const now = new Date().toISOString();
    const events: object[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 2000, ttft_ms: 500 } });
    }
    writeSession("session-render", events);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    const text = renderHealthText(report);

    expect(text).toContain("Provider 健康度");
    expect(text).toContain("openai");
    expect(text).toContain("%"); // 成功率
    // 命令面板固定纯文本：不得含 ANSI 转义序列
    expect(/\x1b\[/.test(text)).toBe(false);
  });

  it("renderHealthText: 无数据时给出提示而非崩溃", () => {
    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    const text = renderHealthText(report);
    expect(text).toContain("无数据");
  });
});
