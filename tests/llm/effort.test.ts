/**
 * src/llm/effort.ts 单测：5 类协议映射矩阵 + max→high 钳制 + env 覆盖 + auto 解析。
 */

import { describe, expect, test } from "bun:test";
import {
  EFFORT_LEVELS,
  isEffortLevel,
  resolveEffortCapability,
  resolveAppliedEffort,
  getDisplayedEffort,
  isEffortAuto,
  resolveThinking,
  getEffortEnvOverride,
  getThinkingEnvOverride,
  previewWireEffort,
} from "../../src/llm/effort.ts";
import type { SendParams } from "../../src/llm/types.ts";

function baseParams(model: string): SendParams {
  return { model, messages: [], maxTokens: 1000 };
}

describe("isEffortLevel / EFFORT_LEVELS", () => {
  test("5 档标度（含 xhigh，对齐 claude-code）", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  test("合法/非法判定", () => {
    expect(isEffortLevel("high")).toBe(true);
    expect(isEffortLevel("max")).toBe(true);
    expect(isEffortLevel("xhigh")).toBe(true);
    expect(isEffortLevel("auto")).toBe(false);
  });
});

describe("resolveEffortCapability — 协议分类", () => {
  test("规则1 DeepSeek OpenAI 端点", () => {
    const cap = resolveEffortCapability({
      model: "deepseek-v4-pro",
      provider: "openai",
      baseURL: "https://api.deepseek.com",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsMaxEffort).toBe(true);
    expect(cap.supportsThinkingToggle).toBe(true);
    expect(cap.thinkingDefaultOn).toBe(true);
  });

  test("规则2 DeepSeek Anthropic 端点（baseURL 含 /anthropic）", () => {
    const cap = resolveEffortCapability({
      model: "deepseek-v4-pro",
      provider: "anthropic",
      baseURL: "https://api.deepseek.com/anthropic",
    });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.thinkingDefaultOn).toBe(true);
    // 验证走 output_config 映射
    const p = baseParams("deepseek-v4-pro");
    cap.applyToSendParams(p, "max", true);
    expect(p.outputConfig).toEqual({ effort: "max" });
  });

  test("规则3 Anthropic 原生 Claude", () => {
    const cap = resolveEffortCapability({ model: "claude-opus-4", provider: "anthropic" });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsMaxEffort).toBe(true);
    expect(cap.thinkingDefaultOn).toBe(false); // 原生默认不开思考
  });

  test("规则4 OpenAI o-series（无 max）", () => {
    const cap = resolveEffortCapability({ model: "o1-preview", provider: "openai" });
    expect(cap.supportsEffort).toBe(true);
    expect(cap.supportsMaxEffort).toBe(false);
    expect(cap.supportsThinkingToggle).toBe(false);
  });

  test("规则5 未知端点（兜底全不支持）", () => {
    const cap = resolveEffortCapability({ model: "llama3", provider: "openai" });
    expect(cap.supportsEffort).toBe(false);
    expect(cap.supportsMaxEffort).toBe(false);
    expect(cap.supportsThinkingToggle).toBe(false);
  });

  // 必删-3 回归：GLM/Grok 同样支持 thinking，此前 app.ts 用 /deepseek/i 判定
  // ThinkingManager 启用，把它们静默排除。这里锁定它们 supportsThinkingToggle=true，
  // 保证 app.ts 改用能力标志后 GLM/Grok 的思考能力不再被无声关闭。
  test("必删-3：GLM（OpenAI 兼容）supportsThinkingToggle=true", () => {
    const cap = resolveEffortCapability({ model: "glm-4.6", provider: "openai" });
    expect(cap.supportsThinkingToggle).toBe(true);
  });

  test("必删-3：Grok（OpenAI 兼容）无 thinking 开关但 reasoning_effort 独立生效", () => {
    const cap = resolveEffortCapability({ model: "grok-4", provider: "openai" });
    // Grok 配置化推理、无显式 thinking 开关 → supportsThinkingToggle=false（ThinkingManager 关，正确）。
    // 但 reasoning_effort 经 loop.ts 的 applyToSendParams 独立下发，不受 ThinkingManager 门控。
    expect(cap.supportsThinkingToggle).toBe(false);
    expect(cap.supportsEffort).toBe(true);
  });

  test("优先级1：modelConfig.supportsThinking=false 强制全不支持", () => {
    const cap = resolveEffortCapability({
      model: "deepseek-v4-pro",
      provider: "openai",
      baseURL: "https://api.deepseek.com",
      modelConfig: { supportsThinking: false },
    });
    expect(cap.supportsEffort).toBe(false);
    expect(cap.supportsThinkingToggle).toBe(false);
  });
});

describe("applyToSendParams — 线格式映射", () => {
  test("规则1 DeepSeek OpenAI：effort→reasoningEffort 二值钳制", () => {
    const cap = resolveEffortCapability({
      model: "deepseek-v4-pro",
      provider: "openai",
      baseURL: "https://api.deepseek.com",
    });
    const low = baseParams("deepseek-v4-pro");
    cap.applyToSendParams(low, "low", true);
    expect(low.thinking).toEqual({ enabled: true, budgetTokens: 0 });
    expect(low.reasoningEffort).toBe("high"); // low→high 钳制

    const max = baseParams("deepseek-v4-pro");
    cap.applyToSendParams(max, "max", true);
    expect(max.reasoningEffort).toBe("max");
  });

  test("规则1 DeepSeek：思考关闭则不下发 effort", () => {
    const cap = resolveEffortCapability({
      model: "deepseek-v4-pro",
      provider: "openai",
      baseURL: "https://api.deepseek.com",
    });
    const p = baseParams("deepseek-v4-pro");
    cap.applyToSendParams(p, "max", false);
    expect(p.thinking).toEqual({ enabled: false, budgetTokens: 0 });
    expect(p.reasoningEffort).toBeUndefined();
  });

  test("规则3 Anthropic 原生：effort→budgetTokens 档位映射", () => {
    const cap = resolveEffortCapability({ model: "claude-opus-4", provider: "anthropic" });
    const cases: [string, number][] = [
      ["low", 2000],
      ["medium", 10000],
      ["high", 20000],
      ["max", 50000],
    ];
    for (const [level, budget] of cases) {
      const p = baseParams("claude-opus-4");
      cap.applyToSendParams(p, level as any, true);
      expect(p.thinking).toEqual({ enabled: true, budgetTokens: budget });
    }
  });

  test("规则3 Anthropic 原生：thinking off 不开思考", () => {
    const cap = resolveEffortCapability({ model: "claude-opus-4", provider: "anthropic" });
    const p = baseParams("claude-opus-4");
    cap.applyToSendParams(p, "max", false);
    expect(p.thinking).toEqual({ enabled: false, budgetTokens: 0 });
  });

  test("规则4 o-series：max→high，low/medium 原样", () => {
    const cap = resolveEffortCapability({ model: "o3-mini", provider: "openai" });
    const p1 = baseParams("o3-mini");
    cap.applyToSendParams(p1, "max", true);
    expect(p1.reasoningEffort).toBe("high");
    const p2 = baseParams("o3-mini");
    cap.applyToSendParams(p2, "low", true);
    expect(p2.reasoningEffort).toBe("low");
  });

  test("规则5 未知端点：全 no-op，不下发任何字段", () => {
    const cap = resolveEffortCapability({ model: "llama3", provider: "openai" });
    const p = baseParams("llama3");
    cap.applyToSendParams(p, "max", true);
    expect(p.thinking).toBeUndefined();
    expect(p.reasoningEffort).toBeUndefined();
    expect(p.outputConfig).toBeUndefined();
  });
});

describe("resolveAppliedEffort — 优先级链 + max 钳制", () => {
  const dsCap = resolveEffortCapability({
    model: "deepseek-v4-pro",
    provider: "openai",
    baseURL: "https://api.deepseek.com",
  });
  const oCap = resolveEffortCapability({ model: "o1", provider: "openai" });

  test("env 未设(null)用 runtime", () => {
    expect(resolveAppliedEffort(dsCap, "high", null)).toBe("high");
  });
  test("env 强制档位覆盖 runtime", () => {
    expect(resolveAppliedEffort(dsCap, "low", "max")).toBe("max");
  });
  test("env 强制 auto(undefined) 覆盖 runtime", () => {
    expect(resolveAppliedEffort(dsCap, "high", undefined)).toBeUndefined();
  });
  test("max→high：模型不支持 max 时降级", () => {
    expect(resolveAppliedEffort(oCap, "max", null)).toBe("high");
  });
  test("runtime auto 保持 undefined", () => {
    expect(resolveAppliedEffort(dsCap, undefined, null)).toBeUndefined();
  });
});

describe("getDisplayedEffort / isEffortAuto", () => {
  const dsCap = resolveEffortCapability({
    model: "deepseek-v4-pro",
    provider: "openai",
    baseURL: "https://api.deepseek.com",
  });
  test("auto 态展示模型默认档", () => {
    expect(getDisplayedEffort(dsCap, undefined, null)).toBe("high");
    expect(isEffortAuto(undefined, null)).toBe(true);
  });
  test("显式档位展示该档（基线，非服务端钳制后）", () => {
    expect(getDisplayedEffort(dsCap, "low", null)).toBe("low"); // 展示用户设的基线 low
    expect(isEffortAuto("low", null)).toBe(false);
  });
  test("env 强制 auto → isEffortAuto true", () => {
    expect(isEffortAuto("high", undefined)).toBe(true);
  });
});

describe("resolveThinking — 优先级链", () => {
  const dsCap = resolveEffortCapability({
    model: "deepseek-v4-pro",
    provider: "openai",
    baseURL: "https://api.deepseek.com",
  });
  const claudeCap = resolveEffortCapability({ model: "claude-opus-4", provider: "anthropic" });

  test("env 覆盖最高", () => {
    expect(resolveThinking(dsCap, "off", true)).toBe(true);
    expect(resolveThinking(dsCap, "on", false)).toBe(false);
  });
  test("runtime on/off", () => {
    expect(resolveThinking(dsCap, "on", null)).toBe(true);
    expect(resolveThinking(dsCap, "off", null)).toBe(false);
  });
  test("auto 跟随 cap.thinkingDefaultOn", () => {
    expect(resolveThinking(dsCap, undefined, null)).toBe(true); // DeepSeek 默认 on
    expect(resolveThinking(claudeCap, undefined, null)).toBe(false); // Claude 默认 off
  });
});

describe("getEffortEnvOverride — env 读取 + 别名兼容", () => {
  test("SID_CODE_EFFORT_LEVEL 优先于 CLAUDE_CODE_EFFORT_LEVEL", () => {
    expect(
      getEffortEnvOverride({ SID_CODE_EFFORT_LEVEL: "max", CLAUDE_CODE_EFFORT_LEVEL: "low" }),
    ).toBe("max");
  });
  test("兼容别名 CLAUDE_CODE_EFFORT_LEVEL", () => {
    expect(getEffortEnvOverride({ CLAUDE_CODE_EFFORT_LEVEL: "high" })).toBe("high");
  });
  test("unset / auto → 强制 auto(undefined)", () => {
    expect(getEffortEnvOverride({ SID_CODE_EFFORT_LEVEL: "unset" })).toBeUndefined();
    expect(getEffortEnvOverride({ SID_CODE_EFFORT_LEVEL: "auto" })).toBeUndefined();
  });
  test("未设 → null", () => {
    expect(getEffortEnvOverride({})).toBeNull();
  });
  test("非法值 → null", () => {
    expect(getEffortEnvOverride({ SID_CODE_EFFORT_LEVEL: "ultra" })).toBeNull();
  });
});

describe("getThinkingEnvOverride", () => {
  test("on/true/1 → true", () => {
    expect(getThinkingEnvOverride({ SID_CODE_THINKING: "on" })).toBe(true);
    expect(getThinkingEnvOverride({ SID_CODE_THINKING: "true" })).toBe(true);
    expect(getThinkingEnvOverride({ SID_CODE_THINKING: "1" })).toBe(true);
  });
  test("off/false/0 → false", () => {
    expect(getThinkingEnvOverride({ SID_CODE_THINKING: "off" })).toBe(false);
    expect(getThinkingEnvOverride({ SID_CODE_THINKING: "false" })).toBe(false);
  });
  test("auto / 未设 / 非法 → null", () => {
    expect(getThinkingEnvOverride({ SID_CODE_THINKING: "auto" })).toBeNull();
    expect(getThinkingEnvOverride({})).toBeNull();
    expect(getThinkingEnvOverride({ SID_CODE_THINKING: "xyz" })).toBeNull();
  });
});

describe("previewWireEffort — 预演实际下发档（钳制提示用）", () => {
  const dsOpenAI = resolveEffortCapability({
    model: "deepseek-v4-pro",
    provider: "openai",
    baseURL: "https://api.deepseek.com",
  });
  const dsAnthropic = resolveEffortCapability({
    model: "deepseek-v4-pro",
    provider: "openai",
    baseURL: "https://api.deepseek.com/anthropic",
  });
  const claudeCap = resolveEffortCapability({ model: "claude-opus-4", provider: "anthropic" });
  const oCap = resolveEffortCapability({ model: "o1", provider: "openai" });
  const unknownCap = resolveEffortCapability({ model: "llama3", provider: "openai" });

  test("DeepSeek OpenAI 端点：low/medium 实际下发 high（被钳制）", () => {
    expect(previewWireEffort(dsOpenAI, "low")).toBe("high");
    expect(previewWireEffort(dsOpenAI, "medium")).toBe("high");
  });
  test("DeepSeek OpenAI 端点：high/max 原样下发（无钳制）", () => {
    expect(previewWireEffort(dsOpenAI, "high")).toBe("high");
    expect(previewWireEffort(dsOpenAI, "max")).toBe("max");
  });
  test("DeepSeek Anthropic 端点：low/medium→high（走 output_config.effort）", () => {
    expect(previewWireEffort(dsAnthropic, "low")).toBe("high");
    expect(previewWireEffort(dsAnthropic, "max")).toBe("max");
  });
  test("o-series：max 实际下发 high（被钳制），low/medium 原样", () => {
    expect(previewWireEffort(oCap, "max")).toBe("high");
    expect(previewWireEffort(oCap, "low")).toBe("low");
    expect(previewWireEffort(oCap, "medium")).toBe("medium");
  });
  test("原生 Claude：走 budget_tokens 无显式 effort 下发 → 返回原档（视为无钳制）", () => {
    for (const lv of EFFORT_LEVELS) {
      expect(previewWireEffort(claudeCap, lv)).toBe(lv);
    }
  });
  test("unknown：no-op → 返回原档", () => {
    expect(previewWireEffort(unknownCap, "max")).toBe("max");
    expect(previewWireEffort(unknownCap, "low")).toBe("low");
  });
});
