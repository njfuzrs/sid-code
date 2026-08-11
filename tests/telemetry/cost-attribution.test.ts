/**
 * Token 成本归因与预算管控测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { BudgetTracker } from "@sid-code/core/telemetry/metrics/budget-tracker.ts";
import type { BudgetRule, BudgetAlert } from "@sid-code/core/telemetry/metrics/budget-tracker.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";

// ============================================================
// TokenMeter 测试
// ============================================================

describe("TokenMeter", () => {
  /** 简单的成本计算函数（模拟 SessionState.calculateCost） */
  function mockCalculateCost(model: string, usage: Usage): number {
    const pricing: Record<string, { input: number; output: number }> = {
      "claude-sonnet-4-20250514": { input: 3, output: 15 },
      "claude-opus-4-20250514": { input: 15, output: 75 },
    };
    const p = pricing[model];
    if (!p) return 0;

    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const cacheCreation = usage.cacheCreationInputTokens ?? 0;
    const regularInput = Math.max(0, usage.inputTokens - cacheRead - cacheCreation);

    let cost = 0;
    cost += (regularInput / 1_000_000) * p.input;
    cost += (cacheRead / 1_000_000) * p.input * 0.1;
    cost += (cacheCreation / 1_000_000) * p.input * 1.25;
    cost += (usage.outputTokens / 1_000_000) * p.output;
    return cost;
  }

  let meter: TokenMeter;

  beforeEach(() => {
    meter = new TokenMeter(null, mockCalculateCost);
  });

  test("记录单次调用并返回成本", () => {
    const usage: Usage = { inputTokens: 1000, outputTokens: 500 };
    const cost = mockCalculateCost("claude-sonnet-4-20250514", usage);
    const result = meter.record({
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      usage,
      costUSD: cost,
    });

    expect(result.costUSD).toBeCloseTo(cost, 6);
    expect(meter.getTotalCost()).toBeCloseTo(cost, 6);
    expect(meter.getCallCount()).toBe(1);
  });

  test("多次调用累计成本", () => {
    const usage1: Usage = { inputTokens: 1000, outputTokens: 500 };
    const usage2: Usage = { inputTokens: 2000, outputTokens: 1000 };
    const cost1 = mockCalculateCost("claude-sonnet-4-20250514", usage1);
    const cost2 = mockCalculateCost("claude-opus-4-20250514", usage2);

    meter.record({ model: "claude-sonnet-4-20250514", provider: "anthropic", usage: usage1, costUSD: cost1 });
    meter.record({ model: "claude-opus-4-20250514", provider: "anthropic", usage: usage2, costUSD: cost2 });

    expect(meter.getTotalCost()).toBeCloseTo(cost1 + cost2, 6);
    expect(meter.getCallCount()).toBe(2);
  });

  test("按模型聚合成本", () => {
    const usage: Usage = { inputTokens: 1000, outputTokens: 500 };
    const sonnetCost = mockCalculateCost("claude-sonnet-4-20250514", usage);
    const opusCost = mockCalculateCost("claude-opus-4-20250514", usage);

    meter.record({ model: "claude-sonnet-4-20250514", provider: "anthropic", usage, costUSD: sonnetCost });
    meter.record({ model: "claude-sonnet-4-20250514", provider: "anthropic", usage, costUSD: sonnetCost });
    meter.record({ model: "claude-opus-4-20250514", provider: "anthropic", usage, costUSD: opusCost });

    const byModel = meter.getCostByModel();
    expect(byModel["claude-sonnet-4-20250514"]).toBeCloseTo(sonnetCost * 2, 6);
    expect(byModel["claude-opus-4-20250514"]).toBeCloseTo(opusCost, 6);
  });

  test("缓存节省计算", () => {
    const usage: Usage = {
      inputTokens: 10000,
      outputTokens: 500,
      cacheReadInputTokens: 5000,
    };
    const cost = mockCalculateCost("claude-sonnet-4-20250514", usage);
    const result = meter.record({
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      usage,
      costUSD: cost,
    });

    // 缓存节省 = 无缓存成本 - 有缓存成本
    expect(result.cacheSavingsUSD).toBeGreaterThan(0);
    expect(meter.getTotalCacheSavings()).toBe(result.cacheSavingsUSD);
  });

  test("未知模型成本为零", () => {
    const usage: Usage = { inputTokens: 1000, outputTokens: 500 };
    const cost = mockCalculateCost("unknown-model", usage);
    const result = meter.record({
      model: "unknown-model",
      provider: "ollama",
      usage,
      costUSD: cost,
    });

    expect(result.costUSD).toBe(0);
    expect(result.cacheSavingsUSD).toBe(0);
  });

  test("getUsages 返回所有记录", () => {
    const usage: Usage = { inputTokens: 1000, outputTokens: 500 };
    const cost = mockCalculateCost("claude-sonnet-4-20250514", usage);

    meter.record({ model: "claude-sonnet-4-20250514", provider: "anthropic", usage, costUSD: cost, sessionId: "s1" });
    meter.record({ model: "claude-sonnet-4-20250514", provider: "anthropic", usage, costUSD: cost, sessionId: "s1" });

    const usages = meter.getUsages();
    expect(usages.length).toBe(2);
    expect(usages[0].sessionId).toBe("s1");
    expect(usages[0].inputTokens).toBe(1000);
    expect(usages[0].outputTokens).toBe(500);
  });
});

// ============================================================
// BudgetTracker 测试
// ============================================================

describe("BudgetTracker", () => {
  function makeRule(overrides: Partial<BudgetRule> = {}): BudgetRule {
    return {
      id: "test-rule",
      name: "测试规则",
      period: "session",
      limitUSD: 1.0,
      thresholds: { warning: 0.5, critical: 0.8, exceeded: 1.0 },
      action: "alert",
      ...overrides,
    };
  }

  test("低于阈值不触发告警", () => {
    const tracker = new BudgetTracker([makeRule()]);
    const alert = tracker.recordCost(0.1, {});
    expect(alert).toBeUndefined();
  });

  test("达到 warning 阈值触发告警", () => {
    const tracker = new BudgetTracker([makeRule()]);
    const alert = tracker.recordCost(0.5, {});
    expect(alert).toBeDefined();
    expect(alert!.level).toBe("warning");
    expect(alert!.ruleId).toBe("test-rule");
  });

  test("告警级别递进（不重复触发同级别）", () => {
    const alerts: BudgetAlert[] = [];
    const tracker = new BudgetTracker([makeRule()], (a) => alerts.push(a));

    tracker.recordCost(0.5, {}); // warning
    tracker.recordCost(0.1, {}); // 仍在 warning，不重复
    tracker.recordCost(0.3, {}); // 达到 critical (0.9)

    expect(alerts.length).toBe(2);
    expect(alerts[0].level).toBe("warning");
    expect(alerts[1].level).toBe("critical");
  });

  test("exceeded 级别触发", () => {
    const tracker = new BudgetTracker([makeRule()]);
    const alert = tracker.recordCost(1.0, {});
    expect(alert).toBeDefined();
    // 一次性达到 exceeded，应该返回最高级别
    expect(alert!.level).toBe("exceeded");
  });

  test("scope 过滤——模型匹配", () => {
    const rule = makeRule({
      id: "opus-only",
      scope: { model: "claude-opus-4-20250514" },
    });
    const tracker = new BudgetTracker([rule]);

    // sonnet 不匹配
    const alert1 = tracker.recordCost(0.6, { model: "claude-sonnet-4-20250514" });
    expect(alert1).toBeUndefined();

    // opus 匹配
    const alert2 = tracker.recordCost(0.6, { model: "claude-opus-4-20250514" });
    expect(alert2).toBeDefined();
    expect(alert2!.level).toBe("warning");
  });

  test("多规则同时检查", () => {
    const rules = [
      makeRule({ id: "global", limitUSD: 10 }),
      makeRule({ id: "opus", limitUSD: 2, scope: { model: "opus" } }),
    ];
    const alerts: BudgetAlert[] = [];
    const tracker = new BudgetTracker(rules, (a) => alerts.push(a));

    // 1.5 对 global(10) 不触发，对 opus(2) 触发 warning
    tracker.recordCost(1.5, { model: "opus" });
    expect(alerts.length).toBe(1);
    expect(alerts[0].ruleId).toBe("opus");
  });

  test("getStatus 返回所有规则状态", () => {
    const tracker = new BudgetTracker([
      makeRule({ id: "r1", limitUSD: 10 }),
      makeRule({ id: "r2", limitUSD: 5 }),
    ]);
    tracker.recordCost(3, {});

    const status = tracker.getStatus();
    expect(status.length).toBe(2);
    expect(status[0].currentUSD).toBe(3);
    expect(status[0].percentage).toBeCloseTo(0.3, 2);
    expect(status[1].currentUSD).toBe(3);
    expect(status[1].percentage).toBeCloseTo(0.6, 2);
  });

  test("shouldBlock 检查 block 动作", () => {
    const tracker = new BudgetTracker([
      makeRule({ action: "block", limitUSD: 1.0 }),
    ]);

    expect(tracker.shouldBlock()).toBe(false);
    tracker.recordCost(1.0, {});
    expect(tracker.shouldBlock()).toBe(true);
  });

  test("isAnyExceeded 检查", () => {
    const tracker = new BudgetTracker([makeRule({ limitUSD: 1.0 })]);

    expect(tracker.isAnyExceeded()).toBe(false);
    tracker.recordCost(1.0, {});
    expect(tracker.isAnyExceeded()).toBe(true);
  });

  test("resetAlertLevels 重置后可重新触发", () => {
    const alerts: BudgetAlert[] = [];
    const tracker = new BudgetTracker([makeRule()], (a) => alerts.push(a));

    tracker.recordCost(0.5, {}); // warning
    expect(alerts.length).toBe(1);

    tracker.resetAlertLevels();
    tracker.recordCost(0.01, {}); // 仍在 warning 范围，重置后可重新触发
    expect(alerts.length).toBe(2);
  });

  test("exceeded + block 动作返回正确 action", () => {
    const tracker = new BudgetTracker([makeRule({ action: "block" })]);
    const alert = tracker.recordCost(1.0, {});
    expect(alert).toBeDefined();
    expect(alert!.action).toBe("block");
  });

  test("exceeded + alert 动作返回 alert action", () => {
    const tracker = new BudgetTracker([makeRule({ action: "alert" })]);
    const alert = tracker.recordCost(1.0, {});
    expect(alert).toBeDefined();
    expect(alert!.action).toBe("alert");
  });
});
