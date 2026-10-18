/**
 * 档位探针吃真名 + adaptive Claude 按注册表透传 xhigh（20261018 effort 排查 B+D：E0 / E2 / E4）
 *
 * 两件事必须同一个 PR：探针吃真名（B）后，若 applier 仍把 xhigh 钳成 max，
 * `getSelectableEfforts` 会把 xhigh 剔出 5.x Claude 的面板、展示层（`getDisplayedEffort`）
 * 会把用户的 xhigh 显示成 max。下面第 3 组断言锁的就是这个顺序约束。
 *
 * 全部走真实 `resolveEffortCapability`（与运行时同源），不手搓 cap。
 */
import { describe, test, expect } from "bun:test";
import {
  resolveEffortCapability,
  previewWireEffort,
  getSelectableEfforts,
  isEffortGatedByThinking,
  getDisplayedEffort,
  type EffortCapability,
} from "@sid-code/core/llm/effort.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

function claude(model: string): EffortCapability {
  return resolveEffortCapability({
    model,
    provider: "anthropic",
    baseURL: "https://api.anthropic.com",
  });
}

function apply(model: string, effort: "xhigh" | "max" | "high", thinking = true): SendParams {
  const cap = claude(model);
  const p: SendParams = { model, wireModel: model, messages: [], maxTokens: 0 };
  cap.applyToSendParams(p, effort, thinking);
  return p;
}

describe("D：adaptive Claude 的 xhigh 按注册表 supportsXhighEffort 透传", () => {
  test("已声明（Opus 5.5 / Sonnet 5 / Opus 5）→ xhigh 原样下发", () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-5", "claude-opus-5"]) {
      const p = apply(m, "xhigh");
      expect(p.outputConfig).toEqual({ effort: "xhigh", thinkingType: "adaptive" });
    }
  });

  test("未声明的 adaptive 模型（Opus 4.6 不在官方矩阵）→ 仍钳 max", () => {
    expect(apply("claude-opus-4-6", "xhigh").outputConfig?.effort).toBe("max");
  });

  test("只认精确命中：模糊命中 claude-opus-5 的未来小版本不借声明", () => {
    // claude-opus-5-6 经模糊匹配命中 claude-opus-5（adaptive），但 xhigh 不跟着借。
    expect(apply("claude-opus-5-6", "xhigh").outputConfig?.effort).toBe("max");
  });

  test("其余档位不受影响", () => {
    expect(apply("claude-opus-5-5", "max").outputConfig?.effort).toBe("max");
    expect(apply("claude-opus-5-5", "high").outputConfig?.effort).toBe("high");
  });
});

describe("B：档位探针吃真名", () => {
  test("cap 携带解析时的真名", () => {
    expect(claude("claude-opus-5-5").wireModel).toBe("claude-opus-5-5");
  });

  test("previewWireEffort：已声明模型 xhigh 无钳制，未声明模型如实报 max", () => {
    expect(previewWireEffort(claude("claude-opus-5-5"), "xhigh")).toBe("xhigh");
    // 此前探针喂空名走 manual 分支，这里会错报 xhigh（E0）。
    expect(previewWireEffort(claude("claude-opus-4-6"), "xhigh")).toBe("max");
  });

  test("门控：always-on（Opus 5.5）关不掉 → 不算被思考门控", () => {
    expect(isEffortGatedByThinking(claude("claude-opus-5-5"))).toBe(false);
  });

  test("门控：可关思考的 adaptive（Opus 5）与 manual 旧模型 → 被门控（E4）", () => {
    expect(isEffortGatedByThinking(claude("claude-opus-5"))).toBe(true);
    // manual 路径的强度载体是 budget_tokens，探针须识别它而不只读档位字段。
    expect(isEffortGatedByThinking(claude("claude-sonnet-4-5-20250514"))).toBe(true);
  });
});

describe("B+D 顺序约束：xhigh 仍在 5.x Claude 可选集内、不被归正改写", () => {
  test("已声明模型 5 档全可选，xhigh 显示为 xhigh", () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
      const cap = claude(m);
      expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(getDisplayedEffort(cap, "xhigh", null)).toBe("xhigh");
    }
  });

  test("未声明的 adaptive 模型剔掉 xhigh，xhigh 显示为实发的 max", () => {
    const cap = claude("claude-opus-4-6");
    expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high", "max"]);
    expect(getDisplayedEffort(cap, "xhigh", null)).toBe("max");
  });
});
