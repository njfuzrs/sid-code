/**
 * /stats 面板单价币种回归：人民币价不能按美元印。
 *
 * 真实 bug（2026-08 随 /model 面板改造发现）：`DialogSwitch` 给 StatsDialog 传的是
 * **裸 `resolvePricing`** 的结果 —— 那是原样存储值，deepseek 系在注册表里存的是
 * `¥9/M` + `currency:"CNY"` + `fxToUSD`。StatsDialog 的 `fmtPrice` 直接加个 `$` 印出来，
 * 于是「¥9」被显示成「$9.00/M」，高估 7.1 倍；分时段折扣同理也没生效。
 *
 * 修复是改用 `resolvePricingUSD`（= resolvePricing + effectivePricing）。
 * 这个测试锁的是**折算这一步不许被绕过**，而不是某个具体数字 —— 单价会随厂商调价变，
 * 「人民币价不能当美元印」不会变。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePricing, resolvePricingUSD } from "@sid-code/core/api/cost-tracker.ts";
import { __resetGatewayPricingForTest } from "@sid-code/core/llm/gateway-pricing.ts";

const CNY_MODEL = "deepseek-v4-pro";

// ⚠ 必须隔离 SID_CONFIG_DIR 并重置模块级内存缓存：resolvePricing 第 3 级会查网关采集价，
// dev 机上存在真实 ~/.sid-code/gateway-pricing.json，会拿渠道价（USD）而不是注册表里的
// 人民币价 → 本测试的前提「注册表里存的是 CNY」直接失效，断言随环境时挂时过。
// 这条坑本仓踩过（见 gateway-pricing-plan-audit-fixes 记忆的第 6 条）。
let tmpDir: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "stats-pricing-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetGatewayPricingForTest();
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  __resetGatewayPricingForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("resolvePricingUSD 必须折平币种（StatsDialog 的取价口径）", () => {
  test("注册表里确实存在以人民币计价的模型（前提成立，否则本测试无意义）", () => {
    const raw = resolvePricing(CNY_MODEL, [{ name: CNY_MODEL }]);
    expect(raw).not.toBeNull();
    expect(raw!.currency).toBe("CNY");
    expect(typeof raw!.fxToUSD).toBe("number");
  });

  test("折算后单价显著低于原样值 —— 直接印原样值就是高估 7 倍", () => {
    const raw = resolvePricing(CNY_MODEL, [{ name: CNY_MODEL }])!;
    const usd = resolvePricingUSD(CNY_MODEL, [{ name: CNY_MODEL }])!;
    expect(usd.input).toBeLessThan(raw.input);
    // 汇率约 1/7.1，允许宽松区间（汇率快照会更新，但量级不会变）
    expect(usd.input).toBeLessThan(raw.input / 5);
  });

  test("折算后 currency 标成 USD（下游据此知道不用再折一次）", () => {
    expect(resolvePricingUSD(CNY_MODEL, [{ name: CNY_MODEL }])!.currency).toBe("USD");
  });

  test("分时段模型：空闲时段价必须比高峰价低（折扣也在这一步生效）", () => {
    const peak = resolvePricingUSD(
      CNY_MODEL,
      [{ name: CNY_MODEL }],
      undefined,
      new Date("2026-08-20T02:00:00Z"),
    )!;
    const off = resolvePricingUSD(
      CNY_MODEL,
      [{ name: CNY_MODEL }],
      undefined,
      new Date("2026-08-20T20:00:00Z"),
    )!;
    expect(off.input).toBeLessThan(peak.input);
  });

  test("纯美元模型折算前后一致（折算不该动本来就是 USD 的价）", () => {
    const name = "claude-opus-4-8";
    const raw = resolvePricing(name, [{ name }])!;
    const usd = resolvePricingUSD(name, [{ name }])!;
    expect(usd.input).toBeCloseTo(raw.input, 10);
    expect(usd.output).toBeCloseTo(raw.output, 10);
  });
});
