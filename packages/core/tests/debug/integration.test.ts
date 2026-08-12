/**
 * Debug 模块集成测试
 */

import { describe, test, expect } from "bun:test";
import { getPerfTimer, getMemoryMonitor, getSessionMetrics } from "@sid-code/core/debug/index.ts";

describe("Debug 模块集成测试", () => {
  test("PerfTimer 基本功能", () => {
    const timer = getPerfTimer();
    timer.clear();

    const handle = timer.start("test_operation");
    // 模拟一些工作
    let sum = 0;
    for (let i = 0; i < 1000; i++) {
      sum += i;
    }
    const duration = handle.end({ result: sum });

    expect(duration).toBeGreaterThan(0);
    const storedDuration = timer.getDuration("test_operation");
    expect(storedDuration).toBeDefined();
    expect(Math.abs(storedDuration! - duration)).toBeLessThan(0.1); // 允许浮点误差

    const summary = timer.getSummary();
    expect(summary).toContain("test_operation");
    expect(summary).toContain("ms");
  });

  test("MemoryMonitor 快照功能", () => {
    const monitor = getMemoryMonitor();

    const snapshot = monitor.getCurrentSnapshot();
    expect(snapshot.timestamp).toBeGreaterThan(0);
    expect(snapshot.heapUsed).toBeGreaterThan(0);
    expect(snapshot.rss).toBeGreaterThan(0);

    const report = monitor.getReport();
    expect(report).toContain("当前内存使用");
    expect(report).toContain("RSS");
    expect(report).toContain("Heap Used");
  });

  test("SessionMetrics 统计功能", () => {
    const metrics = getSessionMetrics();
    metrics.reset();

    // 记录一些指标
    metrics.recordPrompt();
    metrics.recordTurn();
    metrics.recordLlmResponse("claude-opus-4", 1000, 500, 2000, 0.01, false);
    metrics.recordToolCall("read", 100, true);
    metrics.recordToolCall("write", 200, true);
    metrics.recordCompact();
    metrics.updatePeakTokens(50000);

    const snapshot = metrics.getMetrics();
    expect(snapshot.interaction.promptCount).toBe(1);
    expect(snapshot.interaction.turnCount).toBe(1);
    expect(snapshot.llm.totalRequests).toBe(1);
    expect(snapshot.llm.totalInputTokens).toBe(1000);
    expect(snapshot.llm.totalOutputTokens).toBe(500);
    expect(snapshot.tools.totalCalls).toBe(2);
    expect(snapshot.tools.totalSuccess).toBe(2);
    expect(snapshot.context.compactCount).toBe(1);
    expect(snapshot.context.peakTokens).toBe(50000);

    const summary = metrics.getSummary();
    expect(summary).toContain("会话时长");
    expect(summary).toContain("LLM");
    expect(summary).toContain("工具");
    expect(summary).toContain("read");
    expect(summary).toContain("write");
  });

  test("SessionMetrics 按模型统计", () => {
    const metrics = getSessionMetrics();
    metrics.reset();

    metrics.recordLlmResponse("claude-opus-4", 1000, 500, 2000, 0.01, false);
    metrics.recordLlmResponse("claude-opus-4", 800, 400, 1500, 0.008, false);
    metrics.recordLlmResponse("claude-sonnet-4", 500, 300, 1000, 0.003, false);

    const snapshot = metrics.getMetrics();
    expect(snapshot.llm.byModel["claude-opus-4"].requests).toBe(2);
    // inputTokens 取最后一次（覆盖，非累加）：每次 API 调用的 input 已含全部历史，
    // 累加会 N² 过计数。与 SessionState.updateUsage 去重口径一致，故为 800 而非 1800。
    expect(snapshot.llm.byModel["claude-opus-4"].inputTokens).toBe(800);
    expect(snapshot.llm.byModel["claude-sonnet-4"].requests).toBe(1);
  });

  test("SessionMetrics 工具统计", () => {
    const metrics = getSessionMetrics();
    metrics.reset();

    metrics.recordToolCall("read", 100, true);
    metrics.recordToolCall("read", 150, true);
    metrics.recordToolCall("read", 200, false);
    metrics.recordToolCall("write", 300, true);

    const snapshot = metrics.getMetrics();
    expect(snapshot.tools.byName["read"].calls).toBe(3);
    expect(snapshot.tools.byName["read"].success).toBe(2);
    expect(snapshot.tools.byName["read"].fail).toBe(1);
    expect(snapshot.tools.byName["read"].avgDurationMs).toBe(150); // (100+150+200)/3
    expect(snapshot.tools.byName["write"].calls).toBe(1);
  });

  test("PerfTimer 多阶段计时", () => {
    const timer = getPerfTimer();
    timer.clear();

    const h1 = timer.start("phase1");
    h1.end();

    const h2 = timer.start("phase2");
    h2.end({ detail: "test" });

    const h3 = timer.start("phase3");
    h3.end();

    const phases = timer.getPhases();
    expect(phases.length).toBe(3);
    expect(phases.map((p) => p.name)).toContain("phase1");
    expect(phases.map((p) => p.name)).toContain("phase2");
    expect(phases.map((p) => p.name)).toContain("phase3");
  });
});
