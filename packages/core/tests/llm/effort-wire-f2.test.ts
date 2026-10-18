/**
 * F2：改线上请求的那一半（20261018 effort 排查 E3 / E8 xhigh / E10 档位）。
 *
 * - adaptive Claude 的 auto 不发 `output_config.effort`，服务端按模型默认档跑；
 *   `thinking:{type:"adaptive"}` 照发（thinkingType 是协议载体，丢了会退回 manual budget）。
 * - 思考上限的降档在 auto 下仍生效，基准档取注册表默认档。
 * - Grok 4.3 / 4.6 / 4.7 的 xhigh 原样下发；4.5 与未登记的仍钳 high。
 * - GLM-5.2 只剩 high / max；GLM-5.3 的 medium 在 provider 层映射成 high。
 *
 * 全部走真实 `resolveEffortCapability` + 线格式层 `filterParamsForModel`，不手搓 cap。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveEffortCapability,
  getSelectableEfforts,
  previewWireEffort,
  isEffortGatedByThinking,
  type EffortLevel,
} from "@sid-code/core/llm/effort.ts";
import { filterParamsForModel } from "@sid-code/core/llm/model-capability-filter.ts";
import { __resetCapabilityCacheForTest } from "@sid-code/core/llm/model-capabilities.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

const ANTHROPIC = { provider: "anthropic", baseURL: "https://api.anthropic.com" };
const GW = { provider: "openai", baseURL: "https://gw.example.com/v1" };

function apply(
  model: string,
  effort: EffortLevel | undefined,
  where: { provider: string; baseURL: string },
  thinking = true,
): SendParams {
  const cap = resolveEffortCapability({ model, ...where });
  const p: SendParams = { model, wireModel: model, messages: [], maxTokens: 0 };
  cap.applyToSendParams(p, effort, thinking);
  return p;
}

/** 走到线格式层之后的 reasoning_effort（applier + filterParamsForModel）。 */
function chatWire(model: string, effort: EffortLevel): string | undefined {
  const p = apply(model, effort, GW);
  const body: Record<string, unknown> = { reasoning_effort: p.reasoningEffort };
  filterParamsForModel(model, body as never);
  return body.reasoning_effort as string | undefined;
}

// 思考上限 env 两个名字都存/恢复（不无条件 delete，见 CONTRIBUTING 测试约定）。
const CAP_ENVS = ["SID_CODE_MAX_THINKING_TOKENS", "MAX_THINKING_TOKENS"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  __resetCapabilityCacheForTest({});
  for (const k of CAP_ENVS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of CAP_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("adaptive Claude：auto 不发 effort（E3）", () => {
  test("Opus 5.5 / Haiku 5.5 / Opus 5：auto 只发 adaptive，不带 effort", () => {
    for (const m of ["claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5"]) {
      const p = apply(m, undefined, ANTHROPIC);
      expect(p.thinking).toEqual({ enabled: true, budgetTokens: 0 });
      expect(p.outputConfig).toEqual({ thinkingType: "adaptive" });
      expect(p.outputConfig?.effort).toBeUndefined();
    }
  });

  test("显式档位照发（auto 的改动不波及显式选档）", () => {
    expect(apply("claude-opus-5-5", "high", ANTHROPIC).outputConfig).toEqual({
      effort: "high",
      thinkingType: "adaptive",
    });
    expect(
      previewWireEffort(
        resolveEffortCapability({ model: "claude-opus-5-5", ...ANTHROPIC }),
        "xhigh",
      ),
    ).toBe("xhigh");
  });

  test("思考上限在 auto 下仍降档：基准档取注册表默认档", () => {
    // 8K 上限 → medium。Opus 5（默认 high）要降；Opus 5.5（默认 medium）不比默认低，不发。
    process.env.MAX_THINKING_TOKENS = "8000";
    const o5 = apply("claude-opus-5", undefined, ANTHROPIC);
    expect(o5.outputConfig?.effort).toBe("medium");
    expect(o5.thinkingBudgetCapped?.mappedEffort).toBe("medium");
    const o55 = apply("claude-opus-5-5", undefined, ANTHROPIC);
    expect(o55.outputConfig?.effort).toBeUndefined();
    // 2K 上限 → low，两者都降。
    process.env.MAX_THINKING_TOKENS = "2000";
    expect(apply("claude-opus-5-5", undefined, ANTHROPIC).outputConfig?.effort).toBe("low");
  });

  test("门控探针不受影响：Opus 5 仍判被思考门控，Opus 5.5（恒思考）仍判 false", () => {
    expect(
      isEffortGatedByThinking(resolveEffortCapability({ model: "claude-opus-5", ...ANTHROPIC })),
    ).toBe(true);
    expect(
      isEffortGatedByThinking(resolveEffortCapability({ model: "claude-opus-5-5", ...ANTHROPIC })),
    ).toBe(false);
  });
});

describe("Grok xhigh（E8）", () => {
  test("4.3 / 4.6 / 4.7：xhigh 原样下发，且进可选集", () => {
    for (const m of ["grok-4.3", "grok-4.6", "grok-4.7"]) {
      expect(chatWire(m, "xhigh")).toBe("xhigh");
      expect(getSelectableEfforts(resolveEffortCapability({ model: m, ...GW }))).toContain("xhigh");
    }
  });

  test("4.5（官方无 xhigh）与未登记模型仍钳 high；max 一律钳 high", () => {
    expect(chatWire("grok-4.5", "xhigh")).toBe("high");
    expect(apply("grok-4.8", "xhigh", GW).reasoningEffort).toBe("high");
    expect(chatWire("grok-4.7", "max")).toBe("high");
  });
});

describe("GLM 档位（E10）", () => {
  test("GLM-5.2：low / medium → high，xhigh → max；可选集只剩 high / max", () => {
    expect(chatWire("glm-5.2", "low")).toBe("high");
    expect(chatWire("glm-5.2", "medium")).toBe("high");
    expect(chatWire("glm-5.2", "xhigh")).toBe("max");
    expect(getSelectableEfforts(resolveEffortCapability({ model: "glm-5.2", ...GW }))).toEqual([
      "high",
      "max",
    ]);
  });

  test("GLM-5.3：medium 映射成 high（官方只认 low/high/max），low 原样", () => {
    expect(chatWire("glm-5.3", "medium")).toBe("high");
    expect(chatWire("glm-5.3", "low")).toBe("low");
    expect(getSelectableEfforts(resolveEffortCapability({ model: "glm-5.3", ...GW }))).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("没登记档位表的 GLM 保持旧行为", () => {
    expect(apply("glm-5.1", "medium", GW).reasoningEffort).toBe("medium");
    expect(apply("glm-5.1", "xhigh", GW).reasoningEffort).toBe("max");
  });
});
