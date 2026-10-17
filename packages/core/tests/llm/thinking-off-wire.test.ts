/**
 * 20261016 思考开关排查 PR-1：Anthropic 协议线上「关思考」怎么写。
 *
 * 锁的事实（每条都对应排查文档里的一次实测或文档矩阵）：
 *   ① 「不传 = 思考」的模型（Opus 5 / Sonnet 5 / Haiku 5.5、DeepSeek Anthropic 端点）关思考 → 显式 disabled
 *   ② 恒思考模型（5.5 / Fable / Mythos）关思考 → 不发（Sonnet 5.5 发 disabled 实测 400）
 *   ③ 旧 Claude / 未注册 / **仅模糊命中**的未来小版本 → 不发（不知道就不猜）
 *   ④ 发 disabled 时不得带 output_config.effort（Opus 5 + max 实测 400）
 *   ⑤ applier 按真名查注册表（别名不同形时不退回 manual）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { thinkingOffWire } from "@sid-code/core/llm/dialect/thinking-off-wire.ts";
import { buildThinkingWire } from "@sid-code/core/llm/anthropic.ts";
import { resolveEffortCapability } from "@sid-code/core/llm/effort.ts";
import { SIDE_CALL_NO_THINK } from "@sid-code/core/llm/side-call-timeout.ts";
import { setWireModelAliases } from "@sid-code/core/llm/wire-model.ts";
import { lookupRegistryExact, getRegistryEntries } from "@sid-code/core/llm/model-registry.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

/** 主循环路径：真实 applier → 真实线格式层，返回线上 thinking / output_config 片段 */
function mainLoopWire(model: string, thinking: boolean, effort?: "low" | "high" | "max") {
  const cap = resolveEffortCapability({ model, provider: "anthropic" });
  const params: SendParams = { model, messages: [], maxTokens: 1000 } as any;
  cap.applyToSendParams(params, effort, thinking);
  return buildThinkingWire(params, model);
}

describe("thinkingOffWire —— 关思考的线上写法", () => {
  test("① Opus 5 / Sonnet 5 / Haiku 5.5 → disabled", () => {
    expect(thinkingOffWire("claude-opus-5")).toBe("disabled");
    expect(thinkingOffWire("claude-sonnet-5")).toBe("disabled");
    expect(thinkingOffWire("claude-haiku-5-5")).toBe("disabled");
  });

  test("① DeepSeek Anthropic 兼容端点 → disabled（按端点族判，不依赖注册表）", () => {
    expect(thinkingOffWire("deepseek-v4-pro", "https://api.deepseek.com/anthropic")).toBe(
      "disabled",
    );
  });

  test("② 恒思考模型 → 不发（disabled 会 400 或被忽略）", () => {
    for (const m of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-mythos-5",
    ]) {
      expect(thinkingOffWire(m)).toBe("omit");
    }
  });

  test("③ 旧 Claude（不传 = 不思考）→ 不发", () => {
    expect(thinkingOffWire("claude-opus-4-8")).toBe("omit");
    expect(thinkingOffWire("claude-sonnet-4-6")).toBe("omit");
    expect(thinkingOffWire("claude-haiku-4-5")).toBe("omit");
  });

  test("③ 仅模糊命中的未来小版本 → 不发（防 5.6 若恒思考时 off 与全部 side-call 400）", () => {
    // 这几个名字今天会经模糊匹配命中 claude-opus-5 / claude-sonnet-5，继承窗口与定价；
    // 但线上「关」只认精确命中。
    for (const m of [
      "claude-opus-5-6",
      "claude-sonnet-5-7",
      "claude-opus-5-20261101",
      "claude-sonnet-5-gateway",
    ]) {
      expect(lookupRegistryExact(m)).toBeNull();
      expect(thinkingOffWire(m)).toBe("omit");
    }
  });

  test("③ 未注册 / 空名 → 不发", () => {
    expect(thinkingOffWire("some-private-model")).toBe("omit");
    expect(thinkingOffWire("")).toBe("omit");
  });

  test("哨兵：注册表里标 thinkingOmitMeans:'on' 的条目都不是恒思考", () => {
    // 两者矛盾：恒思考模型关不掉，标 "on" 会诱导以后的人以为能发 disabled。
    for (const [key, e] of getRegistryEntries()) {
      if (e.thinkingOmitMeans === "on") expect([key, e.thinkingMode]).toEqual([key, "adaptive"]);
    }
  });
});

describe("buildThinkingWire —— 线格式层（主循环 + side-call 共用的咽喉）", () => {
  test("Sonnet 5 主循环 off → thinking:{type:'disabled'}，不带 effort", () => {
    const w = mainLoopWire("claude-sonnet-5", false, "high");
    expect(w.param).toEqual({ thinking: { type: "disabled" } });
    expect(w.dropEffort).toBe(true);
  });

  test("Sonnet 5 / Opus 5 主循环 on → adaptive（此前缺条目走 manual budget_tokens）", () => {
    for (const m of ["claude-sonnet-5", "claude-opus-5"]) {
      expect(mainLoopWire(m, true, "high").param).toEqual({ thinking: { type: "adaptive" } });
    }
  });

  test("side-call（不经 applier）在 Sonnet 5 上也发 disabled", () => {
    const params = { model: "claude-sonnet-5", thinking: SIDE_CALL_NO_THINK } as SendParams;
    expect(buildThinkingWire(params, "claude-sonnet-5").param).toEqual({
      thinking: { type: "disabled" },
    });
  });

  test("④ disabled 时剥掉残留 outputConfig.effort（Opus 5 + max 实测 400）", () => {
    const params = {
      model: "claude-opus-5",
      thinking: { enabled: false, budgetTokens: 0 },
      outputConfig: { effort: "max", thinkingType: "adaptive" },
    } as SendParams;
    expect(buildThinkingWire(params, "claude-opus-5").dropEffort).toBe(true);
  });

  test("恒思考模型 off → applier 强制 adaptive（不变），线上不出现 disabled", () => {
    const w = mainLoopWire("claude-opus-5-5", false);
    expect(w.param).toEqual({ thinking: { type: "adaptive" } });
    const side = buildThinkingWire(
      { model: "claude-opus-5-5", thinking: SIDE_CALL_NO_THINK } as SendParams,
      "claude-opus-5-5",
    );
    expect(side.param).toEqual({});
  });

  test("旧模型 off → 不发（现状不变）", () => {
    expect(mainLoopWire("claude-opus-4-8", false).param).toEqual({});
  });

  test("没有 thinking 字段 → 不发", () => {
    expect(
      buildThinkingWire({ model: "claude-sonnet-5" } as SendParams, "claude-sonnet-5"),
    ).toEqual({ param: {}, dropEffort: false });
  });
});

describe("⑤ applier 按真名查注册表", () => {
  afterEach(() => setWireModelAliases([]));

  test("别名与真名不同形（my-sonnet → claude-sonnet-5）时仍走 adaptive", () => {
    setWireModelAliases([{ name: "my-sonnet", modelId: "claude-sonnet-5" }]);
    const cap = resolveEffortCapability({ model: "claude-sonnet-5", provider: "anthropic" });
    const params = { model: "my-sonnet", messages: [], maxTokens: 1000 } as any as SendParams;
    cap.applyToSendParams(params, "high", true);
    // 修前按别名 my-sonnet 查注册表 → miss → manual {enabled, budget_tokens}
    expect(params.outputConfig?.thinkingType).toBe("adaptive");
  });
});
