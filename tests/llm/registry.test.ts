/**
 * ProviderRegistry 测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ProviderRegistry } from "../../src/llm/registry.ts";
import type { Config } from "../../src/config/config.ts";
import { defaultConfig } from "../../src/config/config.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";

/** Mock Provider */
class MockProvider implements Provider {
  constructor(private _name: string = "mock") {}
  name() { return this._name; }
  defaultModel() { return "mock-model"; }
  async *sendMessageStream(_params: SendParams): AsyncIterable<StreamEvent> {
    yield { type: "message_stop" } as StreamEvent;
  }
}

/** 创建测试用 Config */
function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    provider: "openai",
    model: "test-model",
    openaiKey: "sk-test",
    baseURL: "https://api.test.com/v1",
    availableModels: [
      { name: "cheap-model", provider: "openai", baseURL: "https://api.cheap.com/v1" },
      { name: "fast-model", provider: "openai", baseURL: "https://api.test.com/v1" },
      { name: "anthropic-model", provider: "anthropic" },
    ],
    ...overrides,
  };
}

describe("ProviderRegistry", () => {
  test("getCurrentModel 返回 config.model", () => {
    const config = testConfig({ model: "my-model" });
    const registry = new ProviderRegistry(config);
    expect(registry.getCurrentModel()).toBe("my-model");
  });

  test("getModelForSubAgent 无映射时返回主模型", () => {
    const config = testConfig({ model: "main-model" });
    const registry = new ProviderRegistry(config);
    expect(registry.getModelForSubAgent("explore")).toBe("main-model");
    expect(registry.getModelForSubAgent("task")).toBe("main-model");
    expect(registry.getModelForSubAgent("plan")).toBe("main-model");
    expect(registry.getModelForSubAgent("summarize")).toBe("main-model");
  });

  test("getModelForSubAgent 有映射时返回映射模型", () => {
    const config = testConfig({ model: "main-model" });
    const registry = new ProviderRegistry(config, {
      explore: "cheap-model",
      summarize: "cheap-model",
    });
    expect(registry.getModelForSubAgent("explore")).toBe("cheap-model");
    expect(registry.getModelForSubAgent("summarize")).toBe("cheap-model");
    // 未映射的类型仍返回主模型
    expect(registry.getModelForSubAgent("task")).toBe("main-model");
    expect(registry.getModelForSubAgent("plan")).toBe("main-model");
  });

  test("clearCache 清除缓存", () => {
    const config = testConfig();
    const registry = new ProviderRegistry(config);

    // 获取一次 provider（会缓存）
    const p1 = registry.getProvider();
    // 清除缓存
    registry.clearCache();
    // 再次获取（应该是新实例）
    const p2 = registry.getProvider();

    // 两次都应该是有效的 Provider
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1.name()).toBe("openai");
    expect(p2.name()).toBe("openai");
  });

  test("getProvider 缓存同配置的 Provider", () => {
    const config = testConfig();
    const registry = new ProviderRegistry(config);

    const p1 = registry.getProvider();
    const p2 = registry.getProvider();

    // 同配置应该返回同一实例
    expect(p1).toBe(p2);
  });

  test("getProviderForSubAgent 模型跟主模型相同时返回主 Provider", () => {
    const config = testConfig({ model: "test-model" });
    const registry = new ProviderRegistry(config);

    const mainProvider = registry.getProvider();
    const subProvider = registry.getProviderForSubAgent("explore");

    expect(subProvider).toBe(mainProvider);
  });

  test("getProviderForSubAgent 模型不同时查找 availableModels", () => {
    const config = testConfig({ model: "main-model" });
    const registry = new ProviderRegistry(config, {
      explore: "cheap-model",
    });

    const subProvider = registry.getProviderForSubAgent("explore");
    // cheap-model 配置了不同的 baseURL，应该创建新 Provider
    expect(subProvider).toBeDefined();
    expect(subProvider.name()).toBe("openai");
  });

  test("未知 provider 类型抛出错误", () => {
    const config = testConfig({ provider: "unknown_provider" });
    const registry = new ProviderRegistry(config);

    expect(() => registry.getProvider()).toThrow("未知的 Provider");
  });
});
