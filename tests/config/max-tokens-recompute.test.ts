/**
 * 切模型 maxTokens 重算/钳制回归测试
 *
 * 事故复盘 20260721-142757：默认模型 deepseek-v4-pro（输出上限 384000）运行时切到
 * glm-5.2（网关上限 131072）后，旧实现 resolveCurrentModelConfig 只在 availableModels
 * 条目显式配了 maxOutputTokens 时才更新 config.maxTokens——glm 条目没配，于是 maxTokens
 * 停在 deepseek 的 384000，发请求即被网关 400 "max_tokens out of range"。
 *
 * 本测试锁定：切模型后 maxTokens 必须按新模型能力重算并钳制到物理上限。
 */

import { describe, test, expect } from "bun:test";
import type { Config } from "../../src/config/config.ts";
import {
  resolveCurrentModelConfig,
  clampMaxTokensToModelCeiling,
} from "../../src/config/config.ts";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    provider: "openai",
    model: "deepseek-v4-pro",
    fallbackModel: "",
    anthropicKey: "",
    openaiKey: "k",
    baseURL: "https://x/v1",
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

describe("切模型 maxTokens 重算", () => {
  test("从高上限模型切到低上限模型：maxTokens 按新模型注册表重算（核心回归）", () => {
    const config = makeConfig({ model: "glm-5.2", maxTokens: 384000 });
    // 模拟运行时切换：config.model 已改为 glm-5.2，maxTokens 仍是上个模型残留的 384000
    resolveCurrentModelConfig(config);
    // glm-5.2 注册表上限 128000（< 网关 131072），必须被重算下来
    expect(config.maxTokens).toBe(128000);
    expect(config.maxTokens).toBeLessThanOrEqual(131072);
  });

  test("从低上限模型切回高上限模型：maxTokens 恢复为新模型上限", () => {
    const config = makeConfig({ model: "deepseek-v4-pro", maxTokens: 128000 });
    resolveCurrentModelConfig(config);
    expect(config.maxTokens).toBe(384000);
  });

  test("用户显式覆盖 maxTokens：尊重覆盖值，但仍钳制到新模型物理上限", () => {
    // 用户显式设 200000。切到 glm-5.2（上限 128000）应钳到 128000，不得放行 200000。
    const config = makeConfig({
      model: "glm-5.2",
      maxTokens: 200000,
      _explicitMaxTokens: 200000,
    });
    resolveCurrentModelConfig(config);
    expect(config.maxTokens).toBe(128000);
  });

  test("用户显式覆盖且在上限内：切到大窗口模型时保留用户值", () => {
    const config = makeConfig({
      model: "deepseek-v4-pro",
      maxTokens: 200000,
      _explicitMaxTokens: 200000,
    });
    resolveCurrentModelConfig(config);
    // deepseek 上限 384000，用户值 200000 在内 → 保留
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
});
