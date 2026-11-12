/**
 * D20（2026-11-10 成本口径核查）：两套计价函数并存。
 *
 * ## 它防的是什么
 *
 * `SessionState.calculateCost`（界面 / 预算守卫）与 `calculateUSDCost`（轨迹重算 /
 * digest 对账）此前各写一份「看起来等价」的公式。两份已经分叉：本地 provider
 * （ollama 等）的免费判断只写在 `calculateCost` 一侧，于是同一个本地模型会话
 * 在界面上是 $0、在轨迹重算里按兜底价算出真金白银，用户拿两条日志对不上。
 *
 * 修法是把公式收成 `calculateCostBreakdown` 一份，两条入口都只对它求和。
 * 所以判据是**逐位相等**（`toBe`，不是 `toBeCloseTo`）—— 只要还有人各乘一遍，
 * 浮点顺序迟早分叉，而这类分叉的症状是「差几分钱」，最容易被当成舍入误差放过。
 *
 * 兜底价同理：以前一处写 `{input, output}` 再派生 0.1 / 1.25，另一处直接写
 * cacheRead/cacheWrite。数值当时相等，改一处却不会带着另一处走 —— 所以本地
 * provider 与未知模型（兜底价）两种路径都必须进这组对账。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionState } from "@sid-code/core/session/state.ts";
import { calculateCostBreakdown, calculateUSDCost } from "@sid-code/core/api/cost-tracker.ts";
import { __resetGatewayPricingForTest } from "@sid-code/core/llm/gateway-pricing.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";

/**
 * 显式钉住两个时刻：DeepSeek 的高峰窗口是 UTC 1–4 / 6–10（见 model-registry）。
 * 不钉时刻的计价断言会随挂钟在高峰/空闲之间跳变一倍。
 */
const PEAK_AT = new Date(Date.UTC(2026, 7, 21, 2, 30, 0)); // UTC 02:30 → 高峰
const OFF_PEAK_AT = new Date(Date.UTC(2026, 7, 21, 12, 30, 0)); // UTC 12:30 → 空闲

// 隔离：把配置目录指向空临时目录，避免读到本机真实 ~/.sid-code/gateway-pricing.json，
// 否则 dev 机上同一模型会命中网关渠道价，与 CI 跑出不同数字（成本断言会变成环境相关）。
let __tmpCfg: string;
let __prevCfg: string | undefined;
beforeAll(() => {
  __prevCfg = process.env.SID_CONFIG_DIR;
  __tmpCfg = mkdtempSync(join(tmpdir(), "cost-formula-unified-"));
  process.env.SID_CONFIG_DIR = __tmpCfg;
  __resetGatewayPricingForTest();
});
afterAll(() => {
  if (__prevCfg === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = __prevCfg;
  __resetGatewayPricingForTest();
  try {
    rmSync(__tmpCfg, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 三段缓存用量都给满，才能真正覆盖「未命中 / 命中 / 写入 / 输出」四项乘法。 */
const USAGE: Usage = {
  inputTokens: 1_234_567,
  outputTokens: 7_890,
  cacheReadInputTokens: 900_000,
  cacheCreationInputTokens: 12_345,
};

interface Case {
  label: string;
  model: string;
  provider: string;
  at?: Date;
}

const CASES: Case[] = [
  {
    label: "anthropic 族（input 为未命中余量 + 显式 cacheRead/cacheWrite）",
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
  },
  {
    label: "openai 族（prompt 含命中）· 高峰时段",
    model: "deepseek-v4-pro",
    provider: "openai",
    at: PEAK_AT,
  },
  {
    label: "openai 族 · 空闲时段（分时段折扣只该乘一次）",
    model: "deepseek-v4-pro",
    provider: "openai",
    at: OFF_PEAK_AT,
  },
  { label: "未知模型（兜底价路径）", model: "no-such-model-xyz", provider: "openai" },
];

describe("D20 — 两条计价入口逐位相同", () => {
  for (const c of CASES) {
    test(c.label, () => {
      const ss = new SessionState("cost-formula-unified");
      // 严格相等：两边都走 calculateCostBreakdown，任何一边恢复成自己乘一遍都不可能稳过。
      expect(calculateUSDCost(c.model, USAGE, undefined, c.provider, undefined, c.at)).toBe(
        ss.calculateCost(c.model, USAGE, c.provider, undefined, c.at),
      );
    });
  }

  test("本地 provider（ollama）：两边都是 0，且 breakdown 标明来源为 local", () => {
    const ss = new SessionState("cost-formula-unified");
    const usage: Usage = { inputTokens: 100_000, outputTokens: 5_000 };
    // 修复前：calculateUSDCost 没有本地判断，会按兜底价算出 $0.25。
    expect(calculateUSDCost("llama3", usage, undefined, "ollama")).toBe(0);
    expect(ss.calculateCost("llama3", usage, "ollama")).toBe(0);
    const b = calculateCostBreakdown("llama3", usage, undefined, "ollama");
    expect(b).toEqual({
      uncachedInputUSD: 0,
      cacheHitUSD: 0,
      cacheWriteUSD: 0,
      outputUSD: 0,
      totalUSD: 0,
      source: "local",
      // 本地 provider 没有分时段政策，tier 恒 "none"（PR-B 新增字段，与 source 同源入账）
      tier: "none",
    });
  });

  test("breakdown 四项之和恒等于 totalUSD（分项账单的对账基础）", () => {
    for (const c of [...CASES, { label: "local", model: "llama3", provider: "ollama" }]) {
      const b = calculateCostBreakdown(c.model, USAGE, undefined, c.provider, undefined, c.at);
      expect(b.uncachedInputUSD + b.cacheHitUSD + b.cacheWriteUSD + b.outputUSD).toBe(b.totalUSD);
    }
  });

  test("取价来源可辨：命中定价表 / 兜底价 / 本地", () => {
    expect(calculateCostBreakdown("claude-sonnet-4-20250514", USAGE).source).toBe("pricing");
    expect(calculateCostBreakdown("no-such-model-xyz", USAGE).source).toBe("fallback");
    expect(calculateCostBreakdown("llama3", USAGE, undefined, "ollama").source).toBe("local");
  });
});
