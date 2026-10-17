/**
 * 20261016 思考开关排查 PR-2：`thinkingControl` + `resolveThinkingState` —— 展示 == 实发。
 *
 * 锁的事实：
 *   ① 控制形态：恒思考 → locked-on；无开关族 → none；其余 → toggle
 *   ② `auto` 默认值按模型：Opus 5 / Sonnet 5 / Haiku 5.5「不传 = 思考」→ true（D7）
 *   ③ 不变量：遍历注册表全部 Anthropic 条目 × 三种意图，展示的 effective
 *      必须等于「真实 applier → 真实线格式层」之后线上是否思考
 *   ④ 意图粘性：locked-on 模型上 intent 仍报 off，effective 报 true
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  resolveEffortCapability,
  resolveThinking,
  resolveThinkingState,
  type ThinkingSetting,
} from "@sid-code/core/llm/effort.ts";
import { buildThinkingWire } from "@sid-code/core/llm/anthropic.ts";
import { getRegistryEntries, lookupRegistryExact } from "@sid-code/core/llm/model-registry.ts";
import { setModelCompat, normalizeModelCompat } from "@sid-code/core/llm/model-compat.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

const anthropicCap = (model: string) => resolveEffortCapability({ model, provider: "anthropic" });

describe("① thinkingControl", () => {
  afterEach(() => setModelCompat([]));

  test("注册表 always-on → locked-on", () => {
    for (const m of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-mythos-5",
    ]) {
      expect(anthropicCap(m).thinkingControl).toBe("locked-on");
    }
  });

  test("GLM-5.3（isThinkingAlwaysOn）→ locked-on；GLM-5.2 → toggle", () => {
    expect(resolveEffortCapability({ model: "glm-5.3", provider: "openai" }).thinkingControl).toBe(
      "locked-on",
    );
    expect(resolveEffortCapability({ model: "glm-5.2", provider: "openai" }).thinkingControl).toBe(
      "toggle",
    );
  });

  test("compat thinking_always_on（网关改名模型）→ locked-on", () => {
    setModelCompat([
      { name: "origin-glm", compat: normalizeModelCompat({ thinking_always_on: true }) },
    ] as any);
    const cap = resolveEffortCapability({
      model: "origin-glm",
      provider: "openai",
      alias: "origin-glm",
    });
    expect(cap.thinkingControl).toBe("locked-on");
  });

  test("可关闭模型 → toggle", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-8"]) {
      expect(anthropicCap(m).thinkingControl).toBe("toggle");
    }
    expect(
      resolveEffortCapability({ model: "deepseek-v4-pro", provider: "openai" }).thinkingControl,
    ).toBe("toggle");
  });

  test("无开关族 → none", () => {
    expect(resolveEffortCapability({ model: "o3", provider: "openai" }).thinkingControl).toBe(
      "none",
    );
    expect(resolveEffortCapability({ model: "grok-4", provider: "openai" }).thinkingControl).toBe(
      "none",
    );
  });

  test("locked-on 不改 supportsThinkingToggle（它还驱动 ThinkingManager 的 ultrathink 提级）", () => {
    expect(anthropicCap("claude-opus-5-5").supportsThinkingToggle).toBe(true);
  });
});

describe("② auto 默认值按模型（D7）", () => {
  test("不传 = 思考的模型 auto → on", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
      expect(resolveThinkingState(anthropicCap(m), undefined, null).effective).toBe(true);
    }
  });

  test("旧 Claude auto → off（不变）", () => {
    expect(resolveThinkingState(anthropicCap("claude-opus-4-8"), undefined, null).effective).toBe(
      false,
    );
  });

  test("仅模糊命中的未来小版本 auto → off（与线格式层同口径，不猜）", () => {
    expect(lookupRegistryExact("claude-opus-5-6")).toBeNull();
    expect(resolveThinkingState(anthropicCap("claude-opus-5-6"), undefined, null).effective).toBe(
      false,
    );
  });
});

describe("③ 不变量：展示 == 实发（Anthropic 协议全部注册条目 × on/off/auto）", () => {
  /** 线上是否思考：发了 adaptive/enabled → 是；disabled → 否；不发 → 看服务端默认 */
  function wireThinks(model: string, wire: { param: Record<string, any> }): boolean {
    const t = wire.param.thinking;
    if (t) return t.type !== "disabled";
    const e = lookupRegistryExact(model);
    return e?.thinkingMode === "always-on" || e?.thinkingOmitMeans === "on";
  }

  const anthropicModels = getRegistryEntries()
    .filter(([, e]) => e.protocolKind === "anthropic-native")
    .map(([k]) => k);

  test("覆盖面哨兵：5 一代条目都在", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-5-5"]) {
      expect(anthropicModels).toContain(m);
    }
  });

  for (const model of anthropicModels) {
    for (const intent of ["on", "off", undefined] as ThinkingSetting[]) {
      test(`${model} × ${intent ?? "auto"}`, () => {
        const cap = anthropicCap(model);
        const shown = resolveThinkingState(cap, intent, null).effective;
        const params = { model, messages: [], maxTokens: 1000 } as any as SendParams;
        cap.applyToSendParams(params, "high", resolveThinking(cap, intent, null));
        expect(wireThinks(model, buildThinkingWire(params, model))).toBe(shown);
      });
    }
  }
});

describe("④ 意图与展示分开", () => {
  test("locked-on 模型 /think off：intent 报 off，effective 报 on", () => {
    const st = resolveThinkingState(anthropicCap("claude-opus-5-5"), "off", null);
    expect(st).toEqual({ intent: "off", effective: true, control: "locked-on" });
  });

  test("env 覆盖优先于 runtime", () => {
    const st = resolveThinkingState(anthropicCap("claude-sonnet-5"), "on", false);
    expect(st.intent).toBe("off");
    expect(st.effective).toBe(false);
  });
});
