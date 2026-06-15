/**
 * ProviderRegistry 测试
 */

import { describe, test, expect } from "bun:test";
import { ProviderRegistry } from "../../src/llm/registry.ts";
import type { Config } from "../../src/config/config.ts";
import { defaultConfig } from "../../src/config/config.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";

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

  test("#9：getContextWindow 优先用 availableModels 声明的 contextWindow", () => {
    const config = testConfig({
      model: "my-1m-model",
      availableModels: [{ name: "my-1m-model", provider: "openai", contextWindow: 1_000_000 }],
    });
    const registry = new ProviderRegistry(config);
    // 子代理据此派生窗口，避免被写死 50000 而对大任务过早压缩
    expect(registry.getContextWindow()).toBe(1_000_000);
  });

  test("#9：getContextWindow 未声明时回退到内置/启发式（deepseek 系 1M）", () => {
    const config = testConfig({ model: "deepseek-v4-pro", availableModels: [] });
    const registry = new ProviderRegistry(config);
    expect(registry.getContextWindow()).toBe(1_000_000);
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

  test("getSpawnConfigForSubAgent：未映射类型沿用主模型 + 主 spawn 配置（P1-1）", () => {
    const config = testConfig({ model: "main-model", provider: "openai", baseURL: "https://api.test.com/v1" });
    const registry = new ProviderRegistry(config);
    const sc = registry.getSpawnConfigForSubAgent("explore");
    expect(sc.model).toBe("main-model");
    expect(sc.providerName).toBe("openai");
    expect(sc.baseURL).toBe("https://api.test.com/v1");
  });

  test("getSpawnConfigForSubAgent：映射类型返回子模型及其 availableModels 中的 provider 配置（P1-1）", () => {
    const config = testConfig({ model: "main-model" });
    const registry = new ProviderRegistry(config, {
      explore: "cheap-model",   // 在 availableModels 中：openai + cheap baseURL
    });
    const sc = registry.getSpawnConfigForSubAgent("explore");
    // 关键：spawn 模式必须用子代理实际模型，而非主模型 —— 否则与进程内模式计费口径分裂
    expect(sc.model).toBe("cheap-model");
    expect(sc.providerName).toBe("openai");
    expect(sc.baseURL).toBe("https://api.cheap.com/v1");
  });

  test("getSpawnConfigForSubAgent：映射到 anthropic 模型时切换 provider（P1-1）", () => {
    const config = testConfig({ model: "main-model", anthropicKey: "sk-ant-test" });
    const registry = new ProviderRegistry(config, {
      plan: "anthropic-model",
    });
    const sc = registry.getSpawnConfigForSubAgent("plan");
    expect(sc.model).toBe("anthropic-model");
    expect(sc.providerName).toBe("anthropic");
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

  // ADR-021 §4.4: mock-* 系列 provider 名走 MockProvider
  test("mock-503 provider 名返回 503 失败模式的 MockProvider", () => {
    const config = testConfig({ provider: "mock-503" });
    const registry = new ProviderRegistry(config);
    const provider = registry.getProvider();
    expect(provider.name()).toBe("mock-503");
    expect(provider.defaultModel()).toBe("test-model");
  });

  test("mock-rate-limit provider 名走 rate_limit 失败模式", () => {
    const config = testConfig({ provider: "mock-rate-limit" });
    const registry = new ProviderRegistry(config);
    const provider = registry.getProvider();
    expect(provider.name()).toBe("mock-rate-limit");
  });

  test("mock-timeout provider 名走 timeout 失败模式", () => {
    const config = testConfig({ provider: "mock-timeout" });
    const registry = new ProviderRegistry(config);
    expect(registry.getProvider().name()).toBe("mock-timeout");
  });

  test("mock-ok provider 名走 ok (永不失败)", () => {
    const config = testConfig({ provider: "mock-ok" });
    const registry = new ProviderRegistry(config);
    expect(registry.getProvider().name()).toBe("mock-ok");
  });

  test("mock-503-after-3 provider 名: 前 3 次成功后才 503", async () => {
    const config = testConfig({ provider: "mock-503-after-3" });
    const registry = new ProviderRegistry(config);
    const provider = registry.getProvider() as any;
    expect(provider.name()).toBe("mock-503-after-3");
    // 调 3 次都应成功
    const sendParams: SendParams = {
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      maxTokens: 10,
    };
    for (let i = 0; i < 3; i++) {
      const events: StreamEvent[] = [];
      for await (const ev of provider.sendMessageStream(sendParams)) events.push(ev);
      expect(events.find((e) => e.type === "message_stop")).toBeDefined();
    }
    // 第 4 次抛 RetryableError
    let threw = false;
    try {
      for await (const _ of provider.sendMessageStream(sendParams)) { /* noop */ }
    } catch (err: any) {
      threw = true;
      expect(err.name).toBe("RetryableError");
      expect(err.reason).toBe("overloaded");
    }
    expect(threw).toBe(true);
  });
});
