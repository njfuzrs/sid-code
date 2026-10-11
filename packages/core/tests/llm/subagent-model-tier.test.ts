/**
 * 子代理模型解析：**没有显式配置就跟主模型**，不做任何隐式选模型。
 *
 * 锁住的五级优先级：
 *   1. subAgentModels[type]（用户按类型配）
 *   2. subAgentModels.default（用户兜底）
 *   3. agentDef.model（frontmatter 显式）
 *   4. modelTier 档位 —— **只**读 SID_CHEAP_MODEL / SID_STRONG_MODEL
 *   5. 主模型
 *
 * 回归背景（2026-10-11 事故）：旧第 4 层会在 availableModels 里按单价自动挑最便宜的。
 * 用户主模型可用、从未配过子代理模型，explore 却被派到一个在其网关分组下无渠道的
 * claude-haiku-5-5，5 个子代理零轮全灭，且用户根本不知道选中的是谁。
 * 本文件的「价格表存在也不派生」用例就是那次事故的形态，**不要**为了"省钱"把它改回去——
 * 想省钱请显式配 subAgentModels 或 SID_CHEAP_MODEL。
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

describe("零配置：所有内置子代理都跟主模型（价格表存在也不派生）", () => {
  test("explore/plan/summarize/task/verify/general-purpose → 主模型", () => {
    const r = new ProviderRegistry(pricedConfig());
    for (const type of ["explore", "plan", "summarize", "task", "verify", "general-purpose"]) {
      expect(r.getModelForSubAgent(type)).toBe("main-model");
    }
  });

  test("事故形态：availableModels 里有更便宜的跨 provider 模型，也绝不被自动选中", () => {
    // 复刻 2026-10-11：主模型 openai 族，表里有个单价更低的 anthropic 族模型
    const r = new ProviderRegistry(
      pricedConfig({
        model: "origin-deepseek-v4-1-flash",
        availableModels: [
          {
            name: "origin-deepseek-v4-1-flash",
            provider: "openai",
            pricing: { input: 0.27, output: 1.1 },
          },
          {
            name: "claude-haiku-5-5",
            provider: "anthropic",
            baseURL: "https://other-gw",
            pricing: { input: 0.1, output: 0.5 },
          },
        ],
      }),
    );
    expect(r.getModelForSubAgent("explore")).toBe("origin-deepseek-v4-1-flash");
    // 连接也必须是主模型的：spawn 配置不能偷偷换到 anthropic
    const sc = r.getSpawnConfigForSubAgent("explore");
    expect(sc.model).toBe("origin-deepseek-v4-1-flash");
    expect(sc.providerName).toBe("openai");
  });

  test("自定义 agent 只声明 modelTier=cheap/strong 且无环境变量 → 主模型", () => {
    registerDynamicAgents([
      {
        agentType: "tier-cheap",
        description: "d",
        whenToUse: "w",
        systemPrompt: "s",
        modelTier: "cheap",
      } as any,
      {
        agentType: "tier-strong",
        description: "d",
        whenToUse: "w",
        systemPrompt: "s",
        modelTier: "strong",
      } as any,
    ]);
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("tier-cheap")).toBe("main-model");
    expect(r.getModelForSubAgent("tier-strong")).toBe("main-model");
  });

  test("无 availableModels → 主模型", () => {
    const r = new ProviderRegistry(pricedConfig({ availableModels: [] }));
    expect(r.getModelForSubAgent("explore")).toBe("main-model");
  });

  test("未知 agent 类型 → 主模型（不抛）", () => {
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("no-such-agent")).toBe("main-model");
  });
});

describe("档位只认显式环境变量", () => {
  test("SID_CHEAP_MODEL 作用于 cheap 档代理（explore/plan/summarize）", () => {
    process.env[CHEAP_KEY] = "my-tiny-model";
    const r = new ProviderRegistry(pricedConfig());
    for (const type of ["explore", "plan", "summarize"]) {
      expect(r.getModelForSubAgent(type)).toBe("my-tiny-model");
    }
    // 非 cheap 档不受影响
    expect(r.getModelForSubAgent("task")).toBe("main-model");
  });

  test("SID_STRONG_MODEL 只作用于 strong 档，cheap 档代理仍跟主模型", () => {
    process.env[STRONG_KEY] = "my-big-model";
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
    expect(r.getModelForSubAgent("heavy")).toBe("my-big-model");
    expect(r.getModelForSubAgent("explore")).toBe("main-model");
  });

  test("空白环境变量视同未设", () => {
    process.env[CHEAP_KEY] = "   ";
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("explore")).toBe("main-model");
  });

  test("modelTier=default → 主模型（环境变量也不生效）", () => {
    process.env[CHEAP_KEY] = "my-tiny-model";
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
});

describe("五级优先级", () => {
  test("用户按类型配置 > 环境变量档位", () => {
    process.env[CHEAP_KEY] = "env-cheap";
    const r = new ProviderRegistry(pricedConfig(), { explore: "user-pick" });
    expect(r.getModelForSubAgent("explore")).toBe("user-pick");
  });

  test("用户 default 兜底 > 环境变量档位", () => {
    process.env[CHEAP_KEY] = "env-cheap";
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

  test("agentDef.model（frontmatter）> 环境变量档位", () => {
    process.env[CHEAP_KEY] = "env-cheap";
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

  test("CLAUDE_CODE_SUBAGENT_MODEL 作为 default 兜底仍生效", () => {
    process.env[CC_KEY] = "cc-model";
    const r = new ProviderRegistry(pricedConfig());
    expect(r.getModelForSubAgent("explore")).toBe("cc-model");
  });
});
