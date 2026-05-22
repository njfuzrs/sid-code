/**
 * ProviderRegistry — Provider 工厂 + 缓存 + 子代理模型映射
 * 所有组件通过 registry 按需获取 provider/model，不再持有固定实例
 */

import type { Provider } from "./provider.ts";
import type { Config, ModelConfig } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";
import { ModelAvailabilityService } from "./availability.ts";

/** 子代理模型映射 */
export interface SubAgentModelMap {
  explore?: string;    // 代码探索（默认跟主模型）
  task?: string;       // 任务执行（默认跟主模型）
  plan?: string;       // 规划分析（默认跟主模型）
  summarize?: string;  // 摘要总结（默认跟主模型）
}

export class ProviderRegistry {
  private config: Config;
  private subAgentModels: SubAgentModelMap;
  /** 缓存：key = "providerName:baseURL" */
  private cache = new Map<string, Provider>();
  /** 模型可用性服务 */
  public availability: ModelAvailabilityService;

  constructor(config: Config, subAgentModels?: SubAgentModelMap) {
    this.config = config;
    this.subAgentModels = subAgentModels ?? {};
    this.availability = new ModelAvailabilityService();
  }

  /** 获取当前主 Provider（根据 config.provider + config.baseURL） */
  getProvider(): Provider {
    return this.getProviderFor(
      this.config.provider,
      this.getApiKey(this.config.provider),
      this.config.baseURL,
    );
  }

  /** 获取指定配置的 Provider（带缓存） */
  getProviderFor(providerName: string, apiKey: string, baseURL?: string): Provider {
    const cacheKey = `${providerName}:${baseURL || ""}`;

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const provider = this.createProvider(providerName, apiKey, baseURL);
    this.cache.set(cacheKey, provider);

    const log = getLogger();
    log.debug("REGISTRY", `创建 Provider: ${providerName}`, { baseURL, cacheKey });

    return provider;
  }

  /** 获取当前模型名 */
  getCurrentModel(): string {
    return this.config.model;
  }

  /** 获取子代理模型（按类型查映射，未配置则跟主模型） */
  getModelForSubAgent(type: string): string {
    const mapped = this.subAgentModels[type as keyof SubAgentModelMap];
    return mapped || this.config.model;
  }

  /** 获取子代理 Provider（根据模型在 availableModels 中的配置自动选择） */
  getProviderForSubAgent(type: string): Provider {
    const model = this.getModelForSubAgent(type);

    // 如果模型跟主模型一样，直接返回主 Provider
    if (model === this.config.model) {
      return this.getProvider();
    }

    // 在 availableModels 中查找模型配置
    const modelConfig = this.findModelConfig(model);
    if (modelConfig) {
      const providerName = modelConfig.provider || this.config.provider;
      const apiKey = modelConfig.apiKey || this.getApiKey(providerName);
      const baseURL = modelConfig.baseURL || (providerName === this.config.provider ? this.config.baseURL : "");
      return this.getProviderFor(providerName, apiKey, baseURL);
    }

    // 未找到配置，用主 Provider + 不同模型名
    return this.getProvider();
  }

  /** 清除缓存（/model 切换 provider 时调用） */
  clearCache(): void {
    this.cache.clear();
    const log = getLogger();
    log.debug("REGISTRY", "Provider 缓存已清除");
  }

  /** 在 availableModels 中查找模型配置 */
  private findModelConfig(modelName: string): ModelConfig | undefined {
    return this.config.availableModels?.find(m => m.name === modelName);
  }

  /** 根据 provider 名称获取对应的 API Key（优先从当前模型配置取） */
  private getApiKey(providerName: string): string {
    const mc = this.findModelConfig(this.config.model);
    if (mc?.apiKey) return mc.apiKey;
    if (providerName === "anthropic") return this.config.anthropicKey;
    if (providerName === "openai") return this.config.openaiKey;
    if (providerName === "ollama") return "ollama";
    return this.config.openaiKey;
  }

  /** 创建 Provider 实例（同步，使用 require 避免顶层 await） */
  private createProvider(providerName: string, apiKey: string, baseURL?: string): Provider {
    switch (providerName) {
      case "anthropic": {
        // 动态导入 Anthropic Provider
        const { AnthropicProvider } = require("./anthropic.ts");
        return new AnthropicProvider(apiKey, this.config.model, baseURL);
      }
      case "openai": {
        const { OpenAIProvider } = require("./openai.ts");
        return new OpenAIProvider(apiKey, this.config.model, baseURL);
      }
      case "ollama": {
        const { OllamaProvider } = require("./ollama.ts");
        return new OllamaProvider(this.config.model, baseURL);
      }
      default:
        throw new Error(`未知的 Provider: ${providerName}`);
    }
  }
}
