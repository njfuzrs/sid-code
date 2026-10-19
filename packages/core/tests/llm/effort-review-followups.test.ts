/**
 * 20261019 effort 方案复审的两处修正。
 *
 * 1. 线格式层 `filterParamsForModel` 与 glm applier 对同一档给同一个答案：表外档位沿标度
 *    **向上**取最近一档。此前线格式层是「表外一律取最高档」，GLM-5.2 的 low 被抬成 max
 *    （跳两档），applier 却是 high；主循环先过 applier 所以暂未触发，绕过 applier 的路径会触发。
 * 2. 每模型 `defaultEffort` 允许模糊命中（与 `reasoningEffortValues` 同口径），网关别名 /
 *    带日期快照名不再退回族常量低报默认档；`supportsXhighEffort` 仍只认精确命中。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveEffortCapability,
  getDisplayedEffort,
  type EffortLevel,
} from "@sid-code/core/llm/effort.ts";
import {
  filterParamsForModel,
  roundEffortToKnownValues,
} from "@sid-code/core/llm/model-capability-filter.ts";
import { __resetCapabilityCacheForTest } from "@sid-code/core/llm/model-capabilities.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

const GW = { provider: "openai", baseURL: "https://gw.example.com/v1" };
const ANTHROPIC = { provider: "anthropic", baseURL: "https://api.anthropic.com" };
const LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function filtered(model: string, effort: string): string | undefined {
  const body: Record<string, unknown> = { reasoning_effort: effort };
  filterParamsForModel(model, body as never);
  return body.reasoning_effort as string | undefined;
}

function applierEffort(model: string, effort: EffortLevel): string | undefined {
  const cap = resolveEffortCapability({ model, ...GW });
  const p: SendParams = { model, wireModel: model, messages: [], maxTokens: 0 };
  cap.applyToSendParams(p, effort, true);
  return p.reasoningEffort;
}

beforeEach(() => {
  __resetCapabilityCacheForTest({});
});

describe("线格式层档位取整：向上取最近一档", () => {
  test("GLM-5.2（high / max）：low、medium → high，不是 max", () => {
    expect(filtered("glm-5.2", "low")).toBe("high");
    expect(filtered("glm-5.2", "medium")).toBe("high");
    expect(filtered("glm-5.2", "xhigh")).toBe("max");
  });

  test("GLM-5.3（low / high / max）：medium → high", () => {
    expect(filtered("glm-5.3", "medium")).toBe("high");
  });

  test("上面没有可取的档时仍取最高档（o-series 收到 max → high，原行为）", () => {
    expect(filtered("o3-mini", "max")).toBe("high");
    expect(roundEffortToKnownValues("bogus", ["low", "high"])).toBe("high");
  });

  test("applier 与线格式层对 GLM 每一档给同一个答案（未经 applier 直达线格式也一样）", () => {
    for (const m of ["glm-5.2", "glm-5.3", "glm-5.3-uniapi"]) {
      for (const lv of LEVELS) {
        const viaApplier = applierEffort(m, lv);
        expect(filtered(m, viaApplier!)).toBe(viaApplier);
        // xhigh 由 applier 先钳成 max（GLM 不认 xhigh），其余档直达线格式应与 applier 同答案
        if (lv !== "xhigh") expect(filtered(m, lv)).toBe(viaApplier);
      }
    }
  });
});

describe("defaultEffort 允许模糊命中", () => {
  test("网关别名继承默认档：origin-glm-5.3 / z-ai/glm-5.3 → max", () => {
    for (const m of ["origin-glm-5.3", "z-ai/glm-5.3"]) {
      expect(
        getDisplayedEffort(resolveEffortCapability({ model: m, ...GW }), undefined, null),
      ).toBe("max");
    }
  });

  test("带日期快照名：claude-opus-5-5-20261001 auto 显示 medium", () => {
    const cap = resolveEffortCapability({ model: "claude-opus-5-5-20261001", ...ANTHROPIC });
    expect(getDisplayedEffort(cap, undefined, null)).toBe("medium");
  });

  test("xhigh 仍只认精确命中：claude-opus-5-6 选 xhigh 照旧钳 max", () => {
    const cap = resolveEffortCapability({ model: "claude-opus-5-6", ...ANTHROPIC });
    const p: SendParams = {
      model: "claude-opus-5-6",
      wireModel: "claude-opus-5-6",
      messages: [],
      maxTokens: 0,
    };
    cap.applyToSendParams(p, "xhigh", true);
    expect(p.outputConfig?.effort).toBe("max");
  });
});
