/**
 * D7：`≈$` 判据的单一事实源测试（`priceCurrency` / `priceFxToUSD` / `isCostFxConverted`）。
 *
 * 修的是「Footer 按模型名含不含 deepseek 决定写 ≈$ 还是 $」——判据从模型名改成
 * 「本会话入账价有没有做过汇率折算」。本文件锁住三条路径：
 *   1. `updateUsage` 记录原始币种/汇率（取 `resolvePricing` 的**原始值**，
 *      不是 `effectivePricing` 折算后的值）；
 *   2. 派生 `isCostFxConverted()` / `getCurrencyConversions()`（Footer / /cost / /debug 共用）；
 *   3. serialize → hydrate 回灌后判据不丢（resume 后 `≈` 不能静默消失）。
 *
 * 价格一律用 `availableModels` 注入（`resolvePricing` 步骤 1/2 命中），
 * **不用真实注册表模型名**：同名模型会先命中本机网关采集价（`gateway-pricing.json`），
 * 测试结果会随这台机器的缓存漂移。
 */

import { test, expect, describe } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { ModelPricing, PricingModelEntry } from "@sid-code/core/api/cost-tracker.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";

const USAGE: Usage = { inputTokens: 1000, outputTokens: 100 };

function modelsWith(pricing: ModelPricing, name = "test-model"): PricingModelEntry[] {
  return [{ name, provider: "openai", pricing }];
}

const CNY_WITH_FX: ModelPricing = {
  input: 9,
  output: 27,
  currency: "CNY",
  fxToUSD: 1 / 7.1,
};

describe("D7 — priceCurrency 记录（updateUsage）", () => {
  test("CNY 计价 + fxToUSD → isCostFxConverted() 为真，并带出换算率", () => {
    const ss = new SessionState("s-fx-cny");
    ss.setAvailableModels(modelsWith(CNY_WITH_FX));
    ss.updateUsage("test-model", USAGE, 10, "openai");

    expect(ss.isCostFxConverted()).toBe(true);
    const conv = ss.getCurrencyConversions();
    expect(conv.length).toBe(1);
    expect(conv[0]!.currency).toBe("CNY");
    // 1 / (1/7.1) = 7.1 —— 展示口径是「1 USD = 7.1 CNY」
    expect(conv[0]!.perUSD).toBeCloseTo(7.1, 6);
  });

  test("T-A6 反向：模型名含 deepseek 但价格是 USD → 不加 ≈（旧实现会误标）", () => {
    // 网关 billing_expr 的系数已经是 USD/1M，模型名却仍叫 deepseek —— 这正是旧实现
    // `/deepseek/i.test(model)` 判错的典型场景（文档 D7 的实测会话就是这种价）。
    const ss = new SessionState("s-fx-usd-deepseek");
    ss.setAvailableModels(
      modelsWith({ input: 0.27, output: 1.1, currency: "USD" }, "deepseek-chat"),
    );
    ss.updateUsage("deepseek-chat", USAGE, 10, "openai");

    expect(ss.isCostFxConverted()).toBe(false);
    expect(ss.getCurrencyConversions()).toEqual([]);
  });

  test("CNY 没给 fxToUSD → 不算折算（计价不猜汇率，这笔钱其实没换汇）", () => {
    // effectivePricing 对「声明非 USD 但缺汇率」的价原样当 USD 用（不猜汇率），
    // 此时金额没有经过换算，加 ≈ 反而是误导。判据必须与计价同口径。
    const ss = new SessionState("s-fx-cny-no-rate");
    ss.setAvailableModels(modelsWith({ input: 9, output: 27, currency: "CNY" }));
    ss.updateUsage("test-model", USAGE, 10, "openai");

    expect(ss.isCostFxConverted()).toBe(false);
  });

  test("T-A7：币种/汇率经过 serialize → hydrate 不丢（resume 后判据不回归）", () => {
    const orig = new SessionState("s-fx-resume");
    orig.setAvailableModels(modelsWith(CNY_WITH_FX));
    orig.updateUsage("test-model", USAGE, 10, "openai");
    expect(orig.isCostFxConverted()).toBe(true);

    const snap = orig.serializeUsageSnapshot();
    const restored = new SessionState("s-fx-resume-2");
    // 回灌前确实是零（复现「漏字段则 resume 后静默判 false」的现场）
    expect(restored.isCostFxConverted()).toBe(false);

    restored.hydrateUsage(snap);
    expect(restored.isCostFxConverted()).toBe(true);
    expect(restored.getCurrencyConversions()[0]!.perUSD).toBeCloseTo(7.1, 6);
  });

  test("/clear（resetCounters）后判据归零，不会沿用上一段的 ≈ 前缀", () => {
    const ss = new SessionState("s-fx-clear");
    ss.setAvailableModels(modelsWith(CNY_WITH_FX));
    ss.updateUsage("test-model", USAGE, 10, "openai");
    expect(ss.isCostFxConverted()).toBe(true);

    ss.resetCounters();
    expect(ss.isCostFxConverted()).toBe(false);
    expect(ss.getCurrencyConversions()).toEqual([]);
  });

  test("多模型会话：只要有一条价折算过就整体加 ≈（金额是混合口径）", () => {
    const ss = new SessionState("s-fx-mixed");
    ss.setAvailableModels([
      { name: "usd-model", provider: "openai", pricing: { input: 2, output: 10 } },
      { name: "cny-model", provider: "openai", pricing: CNY_WITH_FX },
    ]);
    ss.updateUsage("usd-model", USAGE, 10, "openai");
    expect(ss.isCostFxConverted()).toBe(false);

    ss.updateUsage("cny-model", USAGE, 10, "openai");
    expect(ss.isCostFxConverted()).toBe(true);
  });
});
