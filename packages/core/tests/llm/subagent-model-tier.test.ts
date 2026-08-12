/**
 * P0-1：子代理语义模型档位（modelTier）派生 单测
 *
 * 这是「更省」方向上直接影响成本的一段逻辑，必须锁住五级优先级与 fail-open 语义：
 *   1. subAgentModels[type]（用户按类型配）
 *   2. subAgentModels.default（用户兜底）
 *   3. agentDef.model（frontmatter 显式）
 *   4. modelTier 档位派生（env > availableModels 按价排序）
 *   5. 主模型兜底
 *
 * 铁律：不硬编码模型名（档位→模型由价格排序派生），且**绝不返回比主模型更贵的 cheap 档**，
 * 派生失败一律 fail-open 回退主模型而非报错。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import {
  registerDynamicAgents,
  clearDynamicAgents,
} from "@sid-code/core/agent/agent-definition.ts";

const CHEAP_KEY = "SID_CHEAP_MODEL";
const STRONG_KEY = "SID_STRONG_MODEL";
const CC_KEY = "CLAUDE_CODE_SUBAGENT_MODEL";

/** 带定价的模型表：main 居中，budget 最便宜，premium 最贵。 */
function pricedConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    provider: "openai",
    model: "main-model",
    openaiKey: "sk-test",
    availableModels: [
      { name: "budget-model", provider: "openai", pricing: { input: 0.1, output: 0.4 } },
      { name: "main-model", provider: "openai", pricing: { input: 3, output: 15 } },
      { name: "premium-model", provider: "openai", pricing: { input: 15, output: 75 } },
    ],
    ...overrides,
  };
}

afterEach(() => {
  delete process.env[CHEAP_KEY];
  delete process.env[STRONG_KEY];
  delete process.env[CC_KEY];
  clearDynamicAgents();
});

describe("内置 cheap 档代理按价派生到最便宜模型", () => {
  test("explore/plan/summarize 走 cheap 档 → 最便宜模型", () => {
    const r = new ProviderRegistry(pricedConfig());
    for (const type of ["explore", "plan", "summarize"]) {
      expect(r.getModelForSubAgent(type)).toBe("budget-model");
    }
  });

  test("非 cheap 档代理（task）仍用主模型", () => {
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("task")).toBe("main-model");
  });
});

describe("env 档位覆盖（最高权威，不看价格表）", () => {
  test("SID_CHEAP_MODEL 直接指定 cheap 档模型", () => {
    process.env[CHEAP_KEY] = "my-tiny-model";
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("explore")).toBe("my-tiny-model");
  });

  test("SID_STRONG_MODEL 只作用于 strong 档，不影响 cheap 档代理", () => {
    process.env[STRONG_KEY] = "my-big-model";
    const r = new ProviderRegistry(pricedConfig());
    // explore 是 cheap 档，不受 STRONG 影响
    expect(r.getModelForSubAgent("explore")).toBe("budget-model");
  });
});

describe("fail-open：派生不出就回退主模型，绝不报错也绝不更贵", () => {
  test("无 availableModels → 回退主模型", () => {
    const r = new ProviderRegistry(pricedConfig({ availableModels: [] }));
    expect(r.getModelForSubAgent("explore")).toBe("main-model");
  });

  test("模型表无定价信息 → 回退主模型", () => {
    const r = new ProviderRegistry(
      pricedConfig({
        // 刻意不给 pricing，且用不在内置价格表里的名字
        availableModels: [
          { name: "zzz-unknown-a", provider: "openai" },
          { name: "main-model", provider: "openai" },
        ],
      }),
    );
    // 派生不出可靠价格时不乱选，回退主模型
    expect(r.getModelForSubAgent("explore")).toBe("main-model");
  });

  test("最便宜的就是主模型本身 → 不派生，回退主模型", () => {
    const r = new ProviderRegistry(
      pricedConfig({
        model: "budget-model", // 主模型已是最便宜的
      }),
    );
    expect(r.getModelForSubAgent("explore")).toBe("budget-model");
  });

  test("候选比主模型贵/相等 → 拒绝派生（cheap 档绝不更贵）", () => {
    const r = new ProviderRegistry(
      pricedConfig({
        model: "cheapest-main",
        availableModels: [
          { name: "cheapest-main", provider: "openai", pricing: { input: 0.05, output: 0.2 } },
          { name: "pricier", provider: "openai", pricing: { input: 9, output: 30 } },
        ],
      }),
    );
    expect(r.getModelForSubAgent("explore")).toBe("cheapest-main");
  });
});

describe("五级优先级", () => {
  test("用户按类型配置 > 档位派生", () => {
    const r = new ProviderRegistry(pricedConfig(), { explore: "user-pick" });
    expect(r.getModelForSubAgent("explore")).toBe("user-pick");
  });

  test("用户 default 兜底 > 档位派生", () => {
    const r = new ProviderRegistry(pricedConfig(), { default: "user-default" });
    expect(r.getModelForSubAgent("explore")).toBe("user-default");
  });

  test("按类型配置 > default 兜底", () => {
    const r = new ProviderRegistry(pricedConfig(), {
      explore: "by-type",
      default: "user-default",
    });
    expect(r.getModelForSubAgent("explore")).toBe("by-type");
  });

  test("agentDef.model（frontmatter）> 档位派生", () => {
    registerDynamicAgents([
      {
        agentType: "my-agent",
        description: "d",
        whenToUse: "w",
        systemPrompt: "s",
        model: "frontmatter-model",
        modelTier: "cheap",
      } as any,
    ]);
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("my-agent")).toBe("frontmatter-model");
  });

  test("自定义 agent 只声明 modelTier=cheap → 按价派生", () => {
    registerDynamicAgents([
      {
        agentType: "tier-only",
        description: "d",
        whenToUse: "w",
        systemPrompt: "s",
        modelTier: "cheap",
      } as any,
    ]);
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("tier-only")).toBe("budget-model");
  });

  test("modelTier=strong → 派生到最贵模型", () => {
    registerDynamicAgents([
      {
        agentType: "heavy",
        description: "d",
        whenToUse: "w",
        systemPrompt: "s",
        modelTier: "strong",
      } as any,
    ]);
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("heavy")).toBe("premium-model");
  });

  test("modelTier=default → 不派生，用主模型", () => {
    registerDynamicAgents([
      {
        agentType: "plain",
        description: "d",
        whenToUse: "w",
        systemPrompt: "s",
        modelTier: "default",
      } as any,
    ]);
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("plain")).toBe("main-model");
  });

  test("未知 agent 类型 → 主模型兜底（不抛）", () => {
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("no-such-agent")).toBe("main-model");
  });
});
