/**
 * cost-tracker.ts 测试
 * USD 成本计算（含缓存计价）/ 按模型累加 / 格式化摘要
 */

import { describe, test, expect } from "bun:test";
import {
  calculateUSDCost,
  resolvePricing,
  CostTracker,
} from "../../src/api/cost-tracker.ts";
import type { Usage } from "../../src/llm/types.ts";

describe("resolvePricing", () => {
  test("精确匹配", () => {
    const pricing = resolvePricing("claude-opus-4-20250514");
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBe(15);
    expect(pricing!.output).toBe(75);
  });
  test("前缀模糊匹配", () => {
    const pricing = resolvePricing("claude-sonnet-4-20250514-v2");
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBe(3);
    expect(pricing!.output).toBe(15);
  });
  test("未知模型 → null（调用方自行走兜底价）", () => {
    const pricing = resolvePricing("unknown-model");
    expect(pricing).toBeNull();
  });

  test("用户配置 pricing 优先于内置表", () => {
    const userModels = [
      { name: "my-custom-model", pricing: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0.5 } },
    ];
    const pricing = resolvePricing("my-custom-model", userModels);
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBe(1);
    expect(pricing!.output).toBe(5);
    expect(pricing!.cacheRead).toBe(0.05);
    expect(pricing!.cacheWrite).toBe(0.5);
  });

  test("用户配置 pricing 可覆盖同名内置模型价格", () => {
    const userModels = [
      { name: "claude-sonnet-4-20250514", pricing: { input: 1, output: 2 } },
    ];
    const pricing = resolvePricing("claude-sonnet-4-20250514", userModels);
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBe(1);
    expect(pricing!.output).toBe(2);
    // cacheRead/cacheWrite 未在用户 pricing 中声明，应为 undefined（调用方自行衍生）
    expect(pricing!.cacheRead).toBeUndefined();
    expect(pricing!.cacheWrite).toBeUndefined();
  });

  test("未知模型 + calculateUSDCost 仍使用兜底价", () => {
    const usage: Usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const cost = calculateUSDCost("unknown-model", usage);
    // 兜底价 input=$2/M → 期望 $2
    expect(cost).toBeCloseTo(2, 5);
  });
});

describe("resolvePricing — 模型名 + 端点复合键", () => {
  const models = [
    { name: "deepseek-v4-pro", baseURL: "https://gateway.example.com/v1", pricing: { input: 1.64, output: 3.29 } },
    { name: "deepseek-v4-pro", baseURL: "https://api.deepseek.com", pricing: { input: 0.435, output: 0.87 } },
  ];

  test("同名不同端点 → 各自返回不同价（精确复合键）", () => {
    const gw = resolvePricing("deepseek-v4-pro", models, "https://gateway.example.com/v1");
    expect(gw!.input).toBe(1.64);
    const official = resolvePricing("deepseek-v4-pro", models, "https://api.deepseek.com");
    expect(official!.input).toBe(0.435);
  });

  test("端点归一化：带末尾斜杠仍精确命中", () => {
    const gw = resolvePricing("deepseek-v4-pro", models, "https://gateway.example.com/v1/");
    expect(gw!.input).toBe(1.64);
  });

  test("不传 baseURL → 退回旧行为（命中第一条同名）", () => {
    const p = resolvePricing("deepseek-v4-pro", models);
    expect(p!.input).toBe(1.64); // 第一条
  });

  test("端点未匹配任何复合键 → 退回仅名匹配（第一条同名）", () => {
    const p = resolvePricing("deepseek-v4-pro", models, "https://some-other-gateway.com/v1");
    expect(p!.input).toBe(1.64);
  });
});

describe("calculateUSDCost", () => {
  test("纯 input + output（sonnet: 3/15 per M）", () => {
    const usage: Usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = calculateUSDCost("claude-sonnet-4-20250514", usage);
    expect(cost).toBeCloseTo(3 + 15, 5);
  });

  test("缓存读取按 0.1 折扣（Anthropic：input_tokens 已是未命中余量，命中独立相加）", () => {
    // Anthropic 语义：inputTokens = 未命中余量（全价），cacheReadInputTokens = 命中（折价），两者相加。
    // §2.3 修复前的 bug：旧实现把 inputTokens 当含命中、再减一次，对 Anthropic 重复扣减导致费用算低。
    const usage: Usage = {
      inputTokens: 500_000,
      outputTokens: 0,
      cacheReadInputTokens: 500_000,
    };
    const cost = calculateUSDCost("claude-sonnet-4-20250514", usage);
    // uncached = 500k * 3/M = 1.5；cacheRead = 500k * 0.3/M = 0.15
    expect(cost).toBeCloseTo(1.5 + 0.15, 5);
  });

  test("缓存写入按 1.25 加价（Anthropic：input_tokens 不含写入）", () => {
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    };
    const cost = calculateUSDCost("claude-sonnet-4-20250514", usage);
    // uncached = 0；cacheWrite = 1M * 3.75/M = 3.75
    expect(cost).toBeCloseTo(3.75, 5);
  });

  test("OpenAI/DeepSeek：prompt_tokens 含命中，需扣减命中（与 Anthropic 口径相反）", () => {
    // deepseek-v4-pro: input 0.435 / cacheRead 0.0036 per M。inputTokens=prompt_tokens 本就含命中，
    // 归一化后 uncached = input − hit，验证 provider 区分确实生效（同样的原始字段，口径不同结果不同）。
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 500_000,
    };
    const cost = calculateUSDCost("deepseek-v4-pro", usage);
    // uncached = 1M − 500k = 500k → 500k * 0.435/M = 0.2175；hit = 500k * 0.0036/M = 0.0018
    expect(cost).toBeCloseTo(0.2175 + 0.0018, 5);
  });
});

describe("CostTracker", () => {
  test("累加多次请求 + 按模型分维度", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-4-20250514", { inputTokens: 1000, outputTokens: 500 }, 1200);
    t.record("claude-sonnet-4-20250514", { inputTokens: 2000, outputTokens: 800 }, 900);
    const mu = t.modelUsage["claude-sonnet-4-20250514"];
    expect(mu.requestCount).toBe(2);
    // input 取最后一次（避免 N² 过计数）
    expect(mu.inputTokens).toBe(2000);
    expect(mu.outputTokens).toBe(1300);
    expect(t.totalAPIDurationMs).toBe(2100);
    expect(t.totalCostUSD).toBeGreaterThan(0);
  });

  test("多模型分别统计", () => {
    const t = new CostTracker();
    t.record("claude-opus-4-20250514", { inputTokens: 1000, outputTokens: 100 });
    t.record("claude-haiku-4-20250514", { inputTokens: 1000, outputTokens: 100 });
    expect(Object.keys(t.modelUsage).length).toBe(2);
  });

  test("record 返回本次成本", () => {
    const t = new CostTracker();
    const cost = t.record("claude-sonnet-4-20250514", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(3, 5);
  });

  test("formatSummary 含总成本 + 按模型 + 缓存信息", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-4-20250514", {
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadInputTokens: 3000,
    });
    const summary = t.formatSummary();
    expect(summary).toContain("总成本: $");
    expect(summary).toContain("claude-sonnet-4-20250514");
    expect(summary).toContain("cache read");
    expect(summary).toContain("API 耗时");
  });

  test("reset 清空", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-4-20250514", { inputTokens: 1000, outputTokens: 100 });
    t.reset();
    expect(t.totalCostUSD).toBe(0);
    expect(Object.keys(t.modelUsage).length).toBe(0);
  });
});
