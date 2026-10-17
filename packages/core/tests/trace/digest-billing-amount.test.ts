/**
 * S13（20261016 方案 PR-8）：digest 计费金额一致性断言
 *
 * B47 的恒等式只核条数；子代理双记时条数对得上、钱多一倍。这里锁住：
 * 账本 costUSD 与 Σ BilledRequest（按事件时刻取价）偏差 > 1% 必报，≤ 1% 不报，
 * 查不到价 / 老轨迹 / 账本之后的事件不参与。
 */

import { test, expect, describe } from "bun:test";
import { checkBillingAmountConsistency, BILLING_AMOUNT_TOLERANCE } from "../../src/trace/digest.ts";
import { calculateUSDCost } from "../../src/api/cost-tracker.ts";

const MODEL = "claude-sonnet-4-6";
const T0 = Date.parse("2026-10-16T06:00:00Z");

function billed(atMs: number, inputTokens: number, outputTokens: number, model = MODEL) {
  return {
    event: "BilledRequest",
    timestamp: new Date(atMs).toISOString(),
    data: { model, provider: "anthropic", input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function priceOf(inputTokens: number, outputTokens: number, atMs: number): number {
  return calculateUSDCost(
    MODEL,
    { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    undefined,
    "anthropic",
    undefined,
    new Date(atMs),
  );
}

describe("checkBillingAmountConsistency", () => {
  const events = [billed(T0, 10_000, 1_000), billed(T0 + 1_000, 20_000, 2_000)];
  const truth = priceOf(10_000, 1_000, T0) + priceOf(20_000, 2_000, T0 + 1_000);
  const ledgerTs = Math.floor((T0 + 60_000) / 1000);

  test("前提自证：内置价表能给这个模型定价（否则下面的用例全部空转）", () => {
    expect(truth).toBeGreaterThan(0);
  });

  test("账本 = Σ BilledRequest：不报", () => {
    expect(checkBillingAmountConsistency(events, { costUSD: truth, ts: ledgerTs })).toBeUndefined();
  });

  test("子代理双记形态（账本把其中一次多记一遍）：报，且给出偏差", () => {
    const doubled = truth + priceOf(20_000, 2_000, T0 + 1_000);
    const r = checkBillingAmountConsistency(events, { costUSD: doubled, ts: ledgerTs });
    expect(r).toBeDefined();
    expect(r!.ratio).toBeGreaterThan(BILLING_AMOUNT_TOLERANCE);
    expect(r!.count).toBe(2);
  });

  test("偏差在 1% 内：不报", () => {
    expect(
      checkBillingAmountConsistency(events, { costUSD: truth * 1.005, ts: ledgerTs }),
    ).toBeUndefined();
  });

  test("账本 ts 之后的事件（turn-done 之后的 fork）不计入", () => {
    const later = [...events, billed(T0 + 3_600_000, 500_000, 50_000)];
    expect(checkBillingAmountConsistency(later, { costUSD: truth, ts: ledgerTs })).toBeUndefined();
  });

  test("任一事件模型查不到价：不判（digest 拿不到用户 availableModels，宁可不判不误报）", () => {
    const unknown = [...events, billed(T0 + 2_000, 1, 1, "some-private-gateway-model-xyz")];
    expect(
      checkBillingAmountConsistency(unknown, { costUSD: truth * 3, ts: ledgerTs }),
    ).toBeUndefined();
  });

  test("无账本 / 无 BilledRequest（老轨迹）：不判", () => {
    expect(checkBillingAmountConsistency(events, undefined)).toBeUndefined();
    expect(checkBillingAmountConsistency([], { costUSD: 1, ts: ledgerTs })).toBeUndefined();
  });
});
