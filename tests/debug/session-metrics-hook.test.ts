/**
 * SessionMetrics Hook 驱动 + 通用计数器/仪表 测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { SessionMetricsCollector } from "../../src/debug/session-metrics.ts";
import { HookSystem } from "../../src/hook/system.ts";

// ============================================================
// registerHooks — Hook 驱动指标采集
// ============================================================
describe("SessionMetricsCollector.registerHooks", () => {
  let collector: SessionMetricsCollector;
  let hookSystem: HookSystem;

  beforeEach(() => {
    collector = new SessionMetricsCollector();
    hookSystem = new HookSystem();
    collector.registerHooks(hookSystem);
  });

  test("AfterModel hook 触发 recordLlmResponse", async () => {
    await hookSystem.fireAfterModelEvent(
      { model: "claude-sonnet-4", messages: [{ role: "user", content: "hello" }] },
      {
        text: "hi",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20 },
        stop_reason: "end_turn",
        cost_usd: 0.005,
        api_duration_ms: 1200,
      },
    );

    const m = collector.getMetrics();
    expect(m.llm.totalRequests).toBe(1);
    expect(m.llm.totalInputTokens).toBe(100);
    expect(m.llm.totalOutputTokens).toBe(50);
    expect(m.llm.totalCostUSD).toBeCloseTo(0.005);
    expect(m.llm.totalLatencyMs).toBe(1200);
    expect(m.llm.byModel["claude-sonnet-4"]).toBeDefined();
    expect(m.llm.byModel["claude-sonnet-4"].requests).toBe(1);
  });

  test("AfterModel 无 usage 时不记录", async () => {
    await hookSystem.fireAfterModelEvent(
      { model: "claude-sonnet-4", messages: [] },
      { text: "hi", stop_reason: "end_turn" },
    );

    const m = collector.getMetrics();
    expect(m.llm.totalRequests).toBe(0);
  });

  test("PostToolUse hook 触发 recordToolCall（成功）", async () => {
    await hookSystem.firePostToolUseEvent(
      "read",
      { file_path: "/tmp/test.ts" },
      { output: "content" },
      false,
      "tool-1",
      { duration_ms: 42 },
    );

    const m = collector.getMetrics();
    expect(m.tools.totalCalls).toBe(1);
    expect(m.tools.totalSuccess).toBe(1);
    expect(m.tools.totalFail).toBe(0);
    expect(m.tools.totalDurationMs).toBe(42);
    expect(m.tools.byName["read"]).toBeDefined();
    expect(m.tools.byName["read"].calls).toBe(1);
    expect(m.tools.byName["read"].avgDurationMs).toBe(42);
  });

  test("PostToolUse hook 触发 recordToolCall（失败）", async () => {
    await hookSystem.firePostToolUseEvent(
      "bash",
      { command: "rm -rf /" },
      { output: "permission denied" },
      true,
      "tool-2",
      { duration_ms: 10 },
    );

    const m = collector.getMetrics();
    expect(m.tools.totalCalls).toBe(1);
    expect(m.tools.totalSuccess).toBe(0);
    expect(m.tools.totalFail).toBe(1);
    expect(m.tools.byName["bash"].fail).toBe(1);
  });

  test("PostToolUse 无 duration_ms 时默认 0", async () => {
    await hookSystem.firePostToolUseEvent(
      "glob",
      { pattern: "*.ts" },
      { output: "files" },
    );

    const m = collector.getMetrics();
    expect(m.tools.totalCalls).toBe(1);
    expect(m.tools.totalDurationMs).toBe(0);
  });

  test("BeforeModel hook 触发 recordTurn", async () => {
    await hookSystem.fireBeforeModelEvent({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
    });
    await hookSystem.fireBeforeModelEvent({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "world" }],
    });

    const m = collector.getMetrics();
    expect(m.interaction.turnCount).toBe(2);
  });

  test("多轮完整流程", async () => {
    // 2 轮 LLM + 1 次工具调用
    for (let i = 0; i < 2; i++) {
      await hookSystem.fireBeforeModelEvent({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: `turn ${i}` }],
      });
      await hookSystem.fireAfterModelEvent(
        { model: "claude-sonnet-4", messages: [] },
        {
          text: "response",
          usage: { inputTokens: 100, outputTokens: 50 },
          stop_reason: "end_turn",
          cost_usd: 0.005,
          api_duration_ms: 500,
        },
      );
    }
    await hookSystem.firePostToolUseEvent(
      "read",
      { file_path: "/tmp/a.ts" },
      { output: "ok" },
      false,
      "t1",
      { duration_ms: 30 },
    );

    const m = collector.getMetrics();
    expect(m.interaction.turnCount).toBe(2);
    expect(m.llm.totalRequests).toBe(2);
    expect(m.llm.totalCostUSD).toBeCloseTo(0.01);
    expect(m.tools.totalCalls).toBe(1);
  });
});

// ============================================================
// 通用计数器/仪表
// ============================================================
describe("SessionMetricsCollector 通用计数器/仪表", () => {
  let collector: SessionMetricsCollector;

  beforeEach(() => {
    collector = new SessionMetricsCollector();
  });

  test("incrementCounter 基本读写", () => {
    expect(collector.getCounter("edit.firstPassSuccess")).toBe(0);
    collector.incrementCounter("edit.firstPassSuccess");
    expect(collector.getCounter("edit.firstPassSuccess")).toBe(1);
    collector.incrementCounter("edit.firstPassSuccess");
    expect(collector.getCounter("edit.firstPassSuccess")).toBe(2);
  });

  test("incrementCounter 支持自定义 delta", () => {
    collector.incrementCounter("context.trimmedTokens", 500);
    collector.incrementCounter("context.trimmedTokens", 300);
    expect(collector.getCounter("context.trimmedTokens")).toBe(800);
  });

  test("setGauge / getGauge 基本读写", () => {
    expect(collector.getGauge("tools.loadedCount")).toBeUndefined();
    collector.setGauge("tools.loadedCount", 6);
    expect(collector.getGauge("tools.loadedCount")).toBe(6);
    collector.setGauge("tools.loadedCount", 10);
    expect(collector.getGauge("tools.loadedCount")).toBe(10);
  });

  test("getCustomMetrics 返回所有自定义指标", () => {
    collector.incrementCounter("edit.firstPassSuccess", 3);
    collector.incrementCounter("verify.totalRuns", 5);
    collector.setGauge("tools.loadedCount", 8);

    const custom = collector.getCustomMetrics();
    expect(custom.counters["edit.firstPassSuccess"]).toBe(3);
    expect(custom.counters["verify.totalRuns"]).toBe(5);
    expect(custom.gauges["tools.loadedCount"]).toBe(8);
  });

  test("getCustomMetrics 无数据时返回空对象", () => {
    const custom = collector.getCustomMetrics();
    expect(Object.keys(custom.counters)).toHaveLength(0);
    expect(Object.keys(custom.gauges)).toHaveLength(0);
  });

  test("reset 清空自定义指标", () => {
    collector.incrementCounter("edit.firstPassSuccess", 3);
    collector.setGauge("tools.loadedCount", 8);
    collector.reset();

    expect(collector.getCounter("edit.firstPassSuccess")).toBe(0);
    expect(collector.getGauge("tools.loadedCount")).toBeUndefined();
    expect(Object.keys(collector.getCustomMetrics().counters)).toHaveLength(0);
  });

  test("getSummary 包含自定义指标", () => {
    collector.incrementCounter("edit.firstPassSuccess", 3);
    collector.incrementCounter("verify.totalRuns", 5);

    const summary = collector.getSummary();
    expect(summary).toContain("Harness 指标");
    expect(summary).toContain("edit.firstPassSuccess: 3");
    expect(summary).toContain("verify.totalRuns: 5");
  });

  test("getSummary 无自定义指标时不输出 Harness 段", () => {
    const summary = collector.getSummary();
    expect(summary).not.toContain("Harness");
  });
});

describe("SessionMetricsCollector 命中率口径（P2-1：flow，非 stock/flow 混用）", () => {
  test("命中率分母用累计 promptTotal，多轮后不虚高", () => {
    const collector = new SessionMetricsCollector();
    // 模拟 DeepSeek（openai 口径）多轮：每轮 prompt 含历史，命中累加。
    // inputTokens 是含命中的全量 prompt（stock，逐轮增长）；cacheRead 是 per-request 命中。
    // 旧逻辑分母 = 末次 input(stock) + 累计命中(flow) → 多轮后命中累加远超末次输入，命中率虚高甚至 >100%。
    // 新逻辑分母 = 累计 promptTotal(flow) = Σ各轮 prompt_tokens，与累计命中同口径。
    collector.recordLlmResponse("deepseek-v4-pro", 10_000, 100, 500, 0.01, false, 8_000, 0, "openai");
    collector.recordLlmResponse("deepseek-v4-pro", 12_000, 100, 500, 0.01, false, 10_000, 0, "openai");
    collector.recordLlmResponse("deepseek-v4-pro", 14_000, 100, 500, 0.01, false, 12_000, 0, "openai");

    const m = collector.getMetrics();
    // 累计命中 = 8000+10000+12000 = 30000
    expect(m.llm.totalCacheReadTokens).toBe(30_000);
    // 累计 promptTotal = 10000+12000+14000 = 36000（openai 口径 promptTotal=prompt_tokens）
    expect(m.llm.totalCumulativePromptTokens).toBe(36_000);

    // 命中率 = 30000/36000 ≈ 83%，必须 ≤ 100%（旧逻辑用末次 input 14000 作分母会算出 30000/44000 口径错乱）
    const summary = collector.getSummary();
    const match = summary.match(/命中 (\d+)%/);
    expect(match).not.toBeNull();
    const rate = Number(match![1]);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThanOrEqual(100);
    expect(rate).toBe(Math.round((30_000 / 36_000) * 100));
  });
});
