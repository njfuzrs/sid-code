/**
 * P2-1：子代理 effort 不再手写塌缩，走与主循环同一套能力层。
 *
 * 锁的是「同一个档位，子代理发出去的线格式与主循环一致」：
 * - GPT-5.6 族（openai-responses）原生认 xhigh → 原样透传，不再塌成 max；
 * - DeepSeek 只认 high/max → xhigh 钳到 max，low 钳到 high；
 * - o-series 无 max → xhigh/max 都钳到 high；
 * - 原生 Claude manual 路径 → xhigh 是独立预算档（32K），不并进 max（50K）；
 * - 未指定 effort → 关 thinking（子代理默认不思考，既有行为不变）。
 */

import { describe, test, expect } from "bun:test";
import { buildSubAgentEffortParams } from "@sid-code/core/agent/sub-agent-effort.ts";

describe("子代理 effort 按模型族翻译", () => {
  test("GPT-5.6 族 xhigh 原样透传，不塌成 max", () => {
    const xhigh = buildSubAgentEffortParams({
      model: "gpt-5.6",
      providerName: "openai",
      effort: "xhigh",
    });
    const max = buildSubAgentEffortParams({
      model: "gpt-5.6",
      providerName: "openai",
      effort: "max",
    });
    expect(xhigh.reasoningEffort).toBe("xhigh");
    expect(max.reasoningEffort).toBe("max");
    // 两档必须可区分——这正是手写映射丢失的那个信息
    expect(xhigh.reasoningEffort).not.toBe(max.reasoningEffort);
  });

  test("DeepSeek 把 xhigh 钳到 max、low 钳到 high", () => {
    const xhigh = buildSubAgentEffortParams({
      model: "deepseek-v4",
      providerName: "openai",
      effort: "xhigh",
    });
    const low = buildSubAgentEffortParams({
      model: "deepseek-v4",
      providerName: "openai",
      effort: "low",
    });
    expect(xhigh.reasoningEffort).toBe("max");
    expect(low.reasoningEffort).toBe("high");
  });

  test("o-series 无 max：xhigh 与 max 都钳到 high", () => {
    for (const effort of ["xhigh", "max"] as const) {
      const out = buildSubAgentEffortParams({ model: "o3", providerName: "openai", effort });
      expect(out.reasoningEffort).toBe("high");
    }
    const medium = buildSubAgentEffortParams({
      model: "o3",
      providerName: "openai",
      effort: "medium",
    });
    expect(medium.reasoningEffort).toBe("medium");
  });

  test("原生 Claude manual 路径 xhigh 是独立预算档，不并进 max", () => {
    const xhigh = buildSubAgentEffortParams({
      model: "claude-sonnet-4-5",
      providerName: "anthropic",
      effort: "xhigh",
    });
    const max = buildSubAgentEffortParams({
      model: "claude-sonnet-4-5",
      providerName: "anthropic",
      effort: "max",
    });
    expect(xhigh.thinking?.enabled).toBe(true);
    expect(xhigh.thinking?.budgetTokens).toBe(32_000);
    expect(max.thinking?.budgetTokens).toBe(50_000);
  });

  test("未指定 effort → 关 thinking，不下发任何档位", () => {
    const out = buildSubAgentEffortParams({ model: "gpt-5.6", providerName: "openai" });
    expect(out.thinking).toEqual({ enabled: false, budgetTokens: 0 });
    expect(out.reasoningEffort).toBeUndefined();
  });
});
