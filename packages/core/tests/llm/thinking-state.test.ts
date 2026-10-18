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
import { buildThinkingWire, thinkingWireLabel } from "@sid-code/core/llm/anthropic.ts";
import { wireThinks as sharedWireThinks } from "@sid-code/core/llm/thinking-observation.ts";
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
  /**
   * 线上是否思考：发了 adaptive/enabled → 是；disabled → 否；不发 → 看服务端默认。
   *
   * R10：与 digest「展示≠实发」共用同一份判定（thinking-observation.ts），两处口径不会分叉。
   *
   * ⚠ 边界（20261018 复审 T8）：「不发」时读的是注册表 `thinkingOmitMeans`，与被测代码
   * 读同一个字段。所以本不变量锁得住「展示与实发两处一致」，锁不住「注册表数据本身对」——
   * 若某模型的 `thinkingOmitMeans` 写错，两边一起错、这里照样绿。数据正确性只能靠
   * 真网关验收（复审 V1）兜底。下面「显式矩阵」哨兵把期望值手写一份，
   * 至少让注册表的改动必须同时改测试、进 review。
   */
  function wireThinks(model: string, wire: { param: Record<string, any> }): boolean {
    const e = lookupRegistryExact(model);
    return (
      sharedWireThinks(
        thinkingWireLabel(wire.param),
        e?.thinkingMode === "always-on" ? "locked-on" : "toggle",
        e ? (e.thinkingOmitMeans ?? "off") : "off",
      ) ?? false
    );
  }

  const anthropicModels = getRegistryEntries()
    .filter(([, e]) => e.protocolKind === "anthropic-native")
    .map(([k]) => k);

  test("覆盖面哨兵：5 一代条目都在", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-5-5"]) {
      expect(anthropicModels).toContain(m);
    }
  });

  /**
   * 显式矩阵哨兵（20261018 复审 T5，原方案 §9.1）：注册表里**每个**
   * `claude-(opus|sonnet|fable|mythos|haiku)-\d` 键都必须出现在这张手写矩阵里，
   * 且控制形态 / 不传语义与矩阵一致。此前只硬编码 4 个键，新增 5.6 这类条目时不会红。
   * 红了 = 注册表新增或改了条目：**补矩阵，不删断言**（并确认该模型的真实服务端行为）。
   */
  const CLAUDE_MATRIX: Record<string, { control: "toggle" | "locked-on"; omitMeans: "on" | null }> =
    {
      "claude-opus-5-5": { control: "locked-on", omitMeans: null },
      "claude-sonnet-5-5": { control: "locked-on", omitMeans: null },
      "claude-fable-5-1": { control: "locked-on", omitMeans: null },
      "claude-fable-5": { control: "locked-on", omitMeans: null },
      "claude-mythos-5": { control: "locked-on", omitMeans: null },
      "claude-opus-5": { control: "toggle", omitMeans: "on" },
      "claude-sonnet-5": { control: "toggle", omitMeans: "on" },
      "claude-haiku-5-5": { control: "toggle", omitMeans: "on" },
      "claude-opus-4-8": { control: "toggle", omitMeans: null },
      "claude-opus-4-7": { control: "toggle", omitMeans: null },
      "claude-opus-4-6": { control: "toggle", omitMeans: null },
      "claude-opus-4-20250514": { control: "toggle", omitMeans: null },
      "claude-sonnet-4-6": { control: "toggle", omitMeans: null },
      "claude-sonnet-4-5-20250514": { control: "toggle", omitMeans: null },
      "claude-sonnet-4-20250514": { control: "toggle", omitMeans: null },
      "claude-haiku-4-5": { control: "toggle", omitMeans: null },
      "claude-haiku-4-5-20251001": { control: "toggle", omitMeans: null },
      "claude-haiku-4-20250514": { control: "toggle", omitMeans: null },
    };

  test("显式矩阵哨兵：注册表全部 Claude 键都在矩阵里且形态一致", () => {
    const keys = getRegistryEntries()
      .map(([k]) => k)
      .filter((k) => /^claude-(opus|sonnet|fable|mythos|haiku)-\d/.test(k));
    expect(keys.length).toBeGreaterThan(0);
    const missing = keys.filter((k) => !(k in CLAUDE_MATRIX));
    expect(missing).toEqual([]);
    for (const k of keys) {
      const want = CLAUDE_MATRIX[k]!;
      expect({ k, control: anthropicCap(k).thinkingControl }).toEqual({ k, control: want.control });
      expect({ k, omit: lookupRegistryExact(k)?.thinkingOmitMeans ?? null }).toEqual({
        k,
        omit: want.omitMeans,
      });
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
