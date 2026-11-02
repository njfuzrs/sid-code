/**
 * S13（20261016 方案 PR-8）：digest 计费金额一致性断言
 *
 * B47 的恒等式只核条数；子代理双记时条数对得上、钱多一倍。这里锁住：
 * 账本 costUSD 与 Σ BilledRequest（按事件时刻取价）偏差 > 1% 必报，≤ 1% 不报，
 * 查不到价 / 老轨迹 / 账本之后的事件不参与。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBillingAmountConsistency, BILLING_AMOUNT_TOLERANCE } from "../../src/trace/digest.ts";
import { calculateUSDCost } from "../../src/api/cost-tracker.ts";
import { __resetGatewayPricingForTest } from "../../src/llm/gateway-pricing.ts";
import { sidPaths } from "../../src/config/paths.ts";

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

/**
 * 2026-11-02 回归：重算必须按请求实际走的端点取价。
 *
 * 原先 calculateUSDCost 的 baseURL 恒传 undefined，网关采集价一律查不到、落注册表价。
 * ppchat 网关 cacheWrite = 0 而注册表不是 → 本地 116 个命中里 109 个是这个假差额，
 * 被报成 high「有链漏记」。下面用一个 cacheWrite = 0 的网关价复刻：
 * 账本按网关价记账，检测器若仍用注册表价就会报出差额。
 *
 * 落盘隔离：写 gateway-pricing.json，SID_CONFIG_DIR 重定向到 tmpdir 并存/恢复原值。
 */
describe("checkBillingAmountConsistency：按端点取价", () => {
  const GW = "https://gw.example.com";
  const GW_PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.SID_CONFIG_DIR;
    tmp = mkdtempSync(join(tmpdir(), "digest-billing-gw-"));
    process.env.SID_CONFIG_DIR = tmp;
    __resetGatewayPricingForTest();
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 2,
        endpoints: {
          [GW]: {
            source_url: `${GW}/api/pricing`,
            fetched_at: Date.now(),
            pricing_version: "t",
            models: { [MODEL]: { ...GW_PRICE, quotaType: 0 } },
          },
        },
      }),
      "utf8",
    );
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prev;
    __resetGatewayPricingForTest();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 一次带 cache 写入的调用：差额全在 cacheWrite 上，正是事故形态 */
  function billedCached(atMs: number, index: number) {
    return {
      event: "BilledRequest",
      timestamp: new Date(atMs).toISOString(),
      data: {
        model: MODEL,
        provider: "anthropic",
        index,
        input_tokens: 2_000,
        output_tokens: 1_000,
        cache_read_tokens: 0,
        cache_creation_tokens: 200_000,
      },
    };
  }
  function raw(atMs: number, index: number, base: string) {
    return {
      event: "AfterModelRaw",
      timestamp: new Date(atMs).toISOString(),
      data: { index, base_url: base },
    };
  }
  /** 账本真值：按网关价记账 */
  const gwCost = (n: number) =>
    n * ((2_000 * GW_PRICE.input + 1_000 * GW_PRICE.output) / 1_000_000);
  const ledgerTs = Math.floor((T0 + 60_000) / 1000);

  test("前提自证：网关价与注册表价在 cacheWrite 上确实不同（否则下面断言空转）", () => {
    const usage = {
      inputTokens: 2_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 200_000,
    };
    const reg = calculateUSDCost(MODEL, usage, undefined, "anthropic", undefined, new Date(T0));
    const gw = calculateUSDCost(MODEL, usage, undefined, "anthropic", GW, new Date(T0));
    expect(gw).toBeCloseTo(gwCost(1), 6);
    expect(reg).toBeGreaterThan(gw * 2);
  });

  test("按 index 配上 AfterModelRaw 的端点：账本按网关价记账，不报", () => {
    const events = [
      raw(T0, 1, GW),
      billedCached(T0, 1),
      raw(T0 + 1_000, 2, GW),
      billedCached(T0 + 1_000, 2),
    ];
    expect(
      checkBillingAmountConsistency(events, { costUSD: gwCost(2), ts: ledgerTs }),
    ).toBeUndefined();
  });

  test("后台任务（900000+ 段，无 AfterModelRaw）退回会话唯一端点，不报", () => {
    const events = [raw(T0, 1, GW), billedCached(T0, 1), billedCached(T0 + 1_000, 900_001)];
    expect(
      checkBillingAmountConsistency(events, { costUSD: gwCost(2), ts: ledgerTs }),
    ).toBeUndefined();
  });

  test("按端点价重算后真有差额（账本双记）：仍报，并带出所用端点", () => {
    const events = [raw(T0, 1, GW), billedCached(T0, 1)];
    const r = checkBillingAmountConsistency(events, { costUSD: gwCost(2), ts: ledgerTs });
    expect(r).toBeDefined();
    expect(r!.baseURL).toBe(GW);
  });

  test("多端点会话里有调用配不上端点：不判（猜错端点就是事故本身）", () => {
    const events = [
      raw(T0, 1, GW),
      billedCached(T0, 1),
      raw(T0 + 1_000, 2, "https://other.example.com"),
      billedCached(T0 + 1_000, 2),
      billedCached(T0 + 2_000, 900_001),
    ];
    expect(
      checkBillingAmountConsistency(events, { costUSD: gwCost(1), ts: ledgerTs }),
    ).toBeUndefined();
  });

  test("老轨迹无 AfterModelRaw.base_url：沿用注册表价，baseURL 为 undefined", () => {
    const events = [billedCached(T0, 1)];
    const r = checkBillingAmountConsistency(events, { costUSD: gwCost(1), ts: ledgerTs });
    expect(r).toBeDefined();
    expect(r!.baseURL).toBeUndefined();
  });
});
