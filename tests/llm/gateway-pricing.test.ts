/**
 * gateway-pricing.ts 测试 — 网关定价换算公式 + 边界
 *
 * 公式（已用官方价模型核对）：
 *   input  = model_ratio × 2
 *   output = input × completion_ratio
 *   cacheRead  = input × cache_ratio
 *   cacheWrite = input × create_cache_ratio
 *   quota_type=1 → 按次（返回 null，退回兜底）
 */

import { describe, test, expect } from "bun:test";
import { convertRawEntry, derivePricingURL } from "../../src/llm/gateway-pricing.ts";

describe("convertRawEntry — 换算公式", () => {
  test("claude-opus-4-8（官方价核对：in $5 / out $25 / cacheRead $0.5）", () => {
    const r = convertRawEntry({
      model_name: "claude-opus-4-8",
      quota_type: 0,
      model_ratio: 2.5,
      completion_ratio: 5,
      cache_ratio: 0.1,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.input).toBeCloseTo(5, 6);
    expect(r!.entry.output).toBeCloseTo(25, 6);
    expect(r!.entry.cacheRead).toBeCloseTo(0.5, 6);
  });

  test("ali-deepseek-v4-pro（渠道价 in $1.6438 / out $3.2877，非官方 $0.435）", () => {
    const r = convertRawEntry({
      model_name: "ali-deepseek-v4-pro",
      quota_type: 0,
      model_ratio: 0.821915,
      completion_ratio: 2,
      cache_ratio: 0.1,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.input).toBeCloseTo(1.64383, 4);
    expect(r!.entry.output).toBeCloseTo(3.28766, 4);
  });

  test("quota_type=1 按次计费 → perCallUSD，token 价置 0", () => {
    const r = convertRawEntry({
      model_name: "veo-3.1-fast-generate-preview",
      quota_type: 1,
      model_price: 1.2,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.quotaType).toBe(1);
    expect(r!.entry.perCallUSD).toBe(1.2);
    expect(r!.entry.input).toBe(0);
  });

  test("缺 model_name → null", () => {
    expect(convertRawEntry({ quota_type: 0, model_ratio: 1 })).toBeNull();
  });

  test("非法 model_ratio（负数/NaN）→ null", () => {
    expect(convertRawEntry({ model_name: "x", quota_type: 0, model_ratio: -1 })).toBeNull();
    expect(convertRawEntry({ model_name: "x", quota_type: 0, model_ratio: NaN })).toBeNull();
  });

  test("quota_type=1 缺 model_price → null", () => {
    expect(convertRawEntry({ model_name: "x", quota_type: 1 })).toBeNull();
  });
});

describe("derivePricingURL", () => {
  test("剥路径取 origin + /api/pricing", () => {
    expect(derivePricingURL("https://gateway.example.com/v1")).toBe("https://gateway.example.com/api/pricing");
    expect(derivePricingURL("https://gateway.example.com")).toBe("https://gateway.example.com/api/pricing");
  });
});
