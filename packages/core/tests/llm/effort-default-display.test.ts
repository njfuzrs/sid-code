/**
 * auto 态展示档 = 服务端实际按的档（20261018 effort 排查 F1：E1 / E8 / E10）。
 *
 * 规则：auto 时 applier 显式发了档 → 显示发的那档；没发 → 显示每模型的服务端默认档
 * （注册表精确命中 > 能力缓存 `default_effort` > 族常量）。F1 只改展示；F2 改了 adaptive Claude
 * auto 与 GLM-5.2 档位的线上请求（锁在 effort-wire-f2.test.ts），最后一组只锁 F1 范围内不变的部分。
 *
 * 全部走真实 `resolveEffortCapability`，不手搓 cap。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveEffortCapability,
  getDisplayedEffort,
  getSelectableEfforts,
  previewWireEffort,
} from "@sid-code/core/llm/effort.ts";
import {
  __resetCapabilityCacheForTest,
  __sanitizeEntryForTest,
} from "@sid-code/core/llm/model-capabilities.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

function cap(model: string, provider = "openai", baseURL = "https://gw.example.com/v1") {
  return resolveEffortCapability({ model, provider, baseURL });
}

function autoWire(model: string, provider?: string, baseURL?: string): SendParams {
  const c = cap(model, provider, baseURL);
  const p: SendParams = { model, wireModel: model, messages: [], maxTokens: 0 };
  c.applyToSendParams(p, undefined, true);
  return p;
}

beforeEach(() => {
  // 隔离真实能力缓存：本机同步过目录后 kimi-k3 会读到真实档位表。
  __resetCapabilityCacheForTest({});
});

describe("auto 不发 effort 的模型：显示注册表的服务端默认档", () => {
  test("kimi-k3 → max（官方默认 max，此前显示 medium / high）", () => {
    expect(getDisplayedEffort(cap("kimi-k3"), undefined, null)).toBe("max");
  });

  test("Grok 4.5+ → high；4.3 没登记，仍按族常量 low", () => {
    for (const m of ["grok-4.7", "grok-4.6", "grok-4.5"]) {
      expect(getDisplayedEffort(cap(m), undefined, null)).toBe("high");
    }
    expect(getDisplayedEffort(cap("grok-4.3"), undefined, null)).toBe("low");
  });

  test("GLM-5.2 / 5.3 → max（官方默认 max，此前显示 high）", () => {
    for (const m of ["glm-5.2", "glm-5.3"]) {
      expect(getDisplayedEffort(cap(m), undefined, null)).toBe("max");
    }
  });

  test("只认精确命中：模糊借值的未来小版本不继承默认档", () => {
    // grok-4.8 不在表里，族常量 low，不借 4.7 的 high。
    expect(getDisplayedEffort(cap("grok-4.8"), undefined, null)).toBe("low");
  });

  test("默认档恒在可选集内（Footer 不显示一个面板里选不到的档）", () => {
    for (const m of ["kimi-k3", "grok-4.7", "grok-4.3", "glm-5.2", "glm-5.3"]) {
      const c = cap(m);
      const shown = getDisplayedEffort(c, undefined, null);
      expect(getSelectableEfforts(c)).toContain(shown);
    }
  });
});

describe("auto 显式发了档的模型：显示实发档", () => {
  test("manual Claude 开思考：显示 medium，与 10000 预算一致（E1，此前显示 high）", () => {
    const c = cap("claude-sonnet-4-5-20250929", "anthropic", "https://api.anthropic.com");
    expect(getDisplayedEffort(c, undefined, null)).toBe("medium");
  });

  test("adaptive Claude：auto 不发 effort（F2 / E3），展示注册表默认档 medium", () => {
    const c = cap("claude-opus-5-5", "anthropic", "https://api.anthropic.com");
    expect(c.defaultEffort).toBe("medium");
    expect(getDisplayedEffort(c, undefined, null)).toBe("medium");
  });
});

describe("能力缓存：采集目录源的 default_effort", () => {
  test("缓存带 defaultEffort → 未知族 auto 显示它，不再按档位表猜", () => {
    __resetCapabilityCacheForTest({
      "vendor-x-model": { effortValues: ["low", "high", "max"], defaultEffort: "max" },
    });
    expect(getDisplayedEffort(cap("vendor-x-model"), undefined, null)).toBe("max");
  });

  test("缓存不带 defaultEffort → 沿用旧推断（有 medium 取 medium，否则 high）", () => {
    __resetCapabilityCacheForTest({ "vendor-y": { effortValues: ["low", "high", "max"] } });
    expect(getDisplayedEffort(cap("vendor-y"), undefined, null)).toBe("high");
  });

  test("注册表优先于缓存：kimi-k3 缓存里猜成 high，展示仍是 max", () => {
    __resetCapabilityCacheForTest({ "kimi-k3": { effortValues: ["low", "high", "max"] } });
    expect(getDisplayedEffort(cap("kimi-k3"), undefined, null)).toBe("max");
  });

  test("sanitize：合法档位词保留（统一小写），非法值丢弃", () => {
    expect(__sanitizeEntryForTest({ defaultEffort: "HIGH" })?.defaultEffort).toBe("high");
    expect(__sanitizeEntryForTest({ defaultEffort: "bogus", contextWindow: 1000 })).toEqual({
      contextWindow: 1000,
    });
  });
});

describe("线上请求（F1 范围内不变的部分）", () => {
  test("auto 时无开关族与 GLM 仍不发 effort", () => {
    for (const m of ["kimi-k3", "grok-4.7", "glm-5.2"]) {
      expect(autoWire(m).reasoningEffort).toBeUndefined();
    }
  });

  test("auto 时 manual Claude 仍发 10000 预算（adaptive Claude 的改动见 effort-wire-f2.test.ts）", () => {
    const m = autoWire("claude-sonnet-4-5-20250929", "anthropic", "https://api.anthropic.com");
    expect(m.thinking).toEqual({ enabled: true, budgetTokens: 10_000 });
  });

  test("显式档位不受默认档影响", () => {
    expect(previewWireEffort(cap("glm-5.3"), "low")).toBe("low");
    expect(getDisplayedEffort(cap("grok-4.7"), "medium", null)).toBe("medium");
  });
});
