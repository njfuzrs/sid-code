/**
 * 切模型 maxTokens 重算/钳制回归测试
 *
 * 事故复盘 20260721-142757：默认模型 deepseek-v4-pro（当时注册表输出上限 384000）运行时切到
 * glm-5.2（上限 128000）后，旧实现 resolveCurrentModelConfig 只在 availableModels
 * 条目显式配了 maxOutputTokens 时才更新 config.maxTokens——glm 条目没配，于是 maxTokens
 * 停在 deepseek 的 384000，发请求即被网关 400 "max_tokens out of range"。
 *
 * ⚠️ 2026-11-12 语义修正（F1）：`config.maxTokens` 现在是**请求输出预算**，不再是模型物理上限。
 * 旧实现把注册表的物理上限（DeepSeek 384k）原样当每次请求的 max_tokens 发出，而 OpenAI 兼容
 * 协议族按「输入 + max_tokens ≤ 窗口」校验 → 输入过 664k 就被 400 拒绝（见
 * docs-research 的 20261112 上下文占用报告 §2.1 / §7.1）。所以本文件的期望从「按注册表推导」
 * 改为「通用默认预算 + 物理上限钳制」：
 *
 *   · 切模型时预算回到默认值 32,768，不再残留上个模型的物理上限 —— 原事故仍然不复现
 *     （根因是「残留高值」，不是「值等于上限」）；
 *   · 用户显式值仍然优先，但必须钳制到新模型的物理上限；
 *   · 物理上限只作钳制，绝不写回预算（`availableModels[].maxOutputTokens` 同理）。
 */

import { describe, test, expect } from "bun:test";
import type { Config } from "@sid-code/core/config/config.ts";
import {
  resolveCurrentModelConfig,
  clampMaxTokensToModelCeiling,
} from "@sid-code/core/config/config.ts";
import { DEFAULT_REQUEST_MAX_TOKENS } from "@sid-code/core/llm/output-budget.ts";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    provider: "openai",
    model: "deepseek-v4-pro",
    fallbackModel: "",
    anthropicKey: "",
    openaiKey: "k",
    baseURL: "https://x/v1",
    // 刻意用旧实现的残留值：切模型后它必须被重算，而不是被带走
    maxTokens: 384000,
    availableModels: [
      { name: "deepseek-v4-pro", provider: "openai" },
      { name: "glm-5.2", provider: "openai" },
    ],
    permissionMode: "default",
    skipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    yesMode: false,
    sessionId: "",
    continue: false,
    resume: "",
    print: false,
    outputFormat: "text",
    maxTurns: 0,
    systemPrompt: "",
    appendSystemPrompt: "",
    systemPromptFile: "",
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "~/.sid-code/debug.log",
    hooks: [],
    mcpServers: {},
    ...over,
  } as Config;
}

describe("切模型 maxTokens 重算（请求预算语义）", () => {
  test("从高上限模型切到低上限模型：预算回到默认值，不残留上个模型的高上限（核心回归）", () => {
    const config = makeConfig({ model: "glm-5.2", maxTokens: 384000 });
    // 模拟运行时切换：config.model 已改为 glm-5.2，maxTokens 仍是上个模型残留的 384000
    resolveCurrentModelConfig(config);
    // F1 之后不再按注册表推导物理上限；残留值必须被重算成通用默认预算
    expect(config.maxTokens).toBe(DEFAULT_REQUEST_MAX_TOKENS);
    // 且必须落在新模型物理上限内（glm-5.2 = 128000）
    expect(config.maxTokens).toBeLessThanOrEqual(128000);
  });

  test("从低上限模型切回高上限模型：预算同样是默认值，不被物理上限抬高", () => {
    const config = makeConfig({ model: "deepseek-v4-pro", maxTokens: 128000 });
    resolveCurrentModelConfig(config);
    // 旧期望是 384000（= 物理上限）；那正是 F1 的成因：物理上限被当成了请求预算
    expect(config.maxTokens).toBe(DEFAULT_REQUEST_MAX_TOKENS);
  });

  test("用户显式覆盖预算：尊重覆盖值，但仍钳制到新模型物理上限", () => {
    // 用户显式设 200000。切到 glm-5.2（上限 128000）应钳到 128000，不得放行 200000。
    const config = makeConfig({
      model: "glm-5.2",
      maxTokens: 200000,
      _explicitMaxTokens: 200000,
    });
    resolveCurrentModelConfig(config);
    expect(config.maxTokens).toBe(128000);
  });

  test("用户显式覆盖且在上限内：切到大上限模型时保留用户值", () => {
    const config = makeConfig({
      model: "deepseek-v4-pro",
      maxTokens: 200000,
      _explicitMaxTokens: 200000,
    });
    resolveCurrentModelConfig(config);
    // deepseek-v4-pro 上限 393216，用户值 200000 在内 → 保留
    expect(config.maxTokens).toBe(200000);
  });

  test("clampMaxTokensToModelCeiling 幂等：多次调用结果一致", () => {
    const config = makeConfig({ model: "glm-5.2", maxTokens: 999999 });
    clampMaxTokensToModelCeiling(config);
    const once = config.maxTokens;
    clampMaxTokensToModelCeiling(config);
    expect(config.maxTokens).toBe(once);
    expect(config.maxTokens).toBe(128000);
  });

  test("未知模型（注册表无上限）：不臆测上限，保持原值", () => {
    const config = makeConfig({
      model: "my-custom-model",
      maxTokens: 500000,
      availableModels: [{ name: "my-custom-model", provider: "openai" }],
    });
    clampMaxTokensToModelCeiling(config);
    expect(config.maxTokens).toBe(500000);
  });

  test("availableModels[].maxOutputTokens 属于物理上限：只作钳制，不写回预算", () => {
    // 用户对这条渠道声明「最多能输出 64k」。它是上限声明，不是「每次请求预留 64k」。
    const config = makeConfig({
      model: "my-custom-model",
      maxTokens: 32768,
      availableModels: [{ name: "my-custom-model", provider: "openai", maxOutputTokens: 64000 }],
    });
    resolveCurrentModelConfig(config);
    expect(config.maxTokens).toBe(DEFAULT_REQUEST_MAX_TOKENS);
    // 预算超过渠道上限时才钳制（物理上限的「只作钳制」语义）
    const overflow = makeConfig({
      model: "my-custom-model",
      maxTokens: 200000,
      _explicitMaxTokens: 200000,
      availableModels: [{ name: "my-custom-model", provider: "openai", maxOutputTokens: 64000 }],
    });
    resolveCurrentModelConfig(overflow);
    expect(overflow.maxTokens).toBe(64000);
  });
});
