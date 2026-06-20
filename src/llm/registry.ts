/**
 * ProviderRegistry — Provider 工厂 + 缓存 + 子代理模型映射
 * 所有组件通过 registry 按需获取 provider/model，不再持有固定实例
 */

import type { Provider } from "./provider.ts";
import type { Config, ModelConfig } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";
import { ModelAvailabilityService } from "./availability.ts";
import { TokenEstimator } from "./token-estimator.ts";

/** 子代理模型映射 */
export interface SubAgentModelMap {
  /** 兜底默认：所有未单独指定的子代理类型都用它；未配则跟主模型。
   *  解析优先级：按类型显式配置 > default > 主模型。 */
  default?: string;
  explore?: string;    // 代码探索（默认跟 default / 主模型）
  task?: string;       // 任务执行（默认跟 default / 主模型）
  plan?: string;       // 规划分析（默认跟 default / 主模型）
  summarize?: string;  // 摘要总结（默认跟 default / 主模型）
  verify?: string;     // 对抗式验证（默认跟 default / 主模型）
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

  /** 获取当前主模型的上下文窗口大小（tokens）。
   *  优先用 availableModels 声明的 contextWindow（权威），否则按内置表/启发式推导。
   *  供子代理派生其 ContextManager 窗口使用，避免子代理被写死 50000 而对大任务过早压缩。 */
  getContextWindow(): number {
    return new TokenEstimator().getContextLimit(this.config.model, this.config.availableModels);
  }

  /** 获取输出语言偏好 */
  getLanguage(): "zh" | "en" | undefined {
    return this.config.language;
  }

  /** 获取用于子进程 spawn 的 Provider 配置（含 API Key — 仅调用方通过管道传递） */
  getSpawnConfig(): { providerName: string; apiKey: string; baseURL?: string } {
    return {
      providerName: this.config.provider,
      apiKey: this.getApiKey(this.config.provider),
      baseURL: this.config.baseURL || undefined,
    };
  }

  /** 获取子代理模型（按类型查映射 > default 兜底 > 主模型） */
  getModelForSubAgent(type: string): string {
    const mapped = this.subAgentModels[type as keyof SubAgentModelMap];
    return mapped || this.subAgentModels.default || this.config.model;
  }

  /**
   * 获取子代理 spawn 配置（按类型解析模型 + 对应 provider/apiKey/baseURL）。
   *
   * 计费口径修复：spawn 模式此前固定用主模型 + 主 provider 配置（this.model / getSpawnConfig），
   * 与进程内模式 getModelForSubAgent/getProviderForSubAgent 的"按类型选模型"口径分裂——
   * 配了 subAgentModels 时同一子任务在两种执行模式下会按不同模型计费（可差数十倍）。
   * 此方法让 spawn 与进程内对齐：返回子代理实际模型及其在 availableModels 中配置的 provider。
   */
  getSpawnConfigForSubAgent(type: string): {
    model: string;
    providerName: string;
    apiKey: string;
    baseURL?: string;
  } {
    const model = this.getModelForSubAgent(type);
    // 子代理模型与主模型相同 → 复用主 spawn 配置
    if (model === this.config.model) {
      const base = this.getSpawnConfig();
      return { model, providerName: base.providerName, apiKey: base.apiKey, baseURL: base.baseURL };
    }
    // 子代理模型在 availableModels 中有独立配置 → 用其 provider/apiKey/baseURL
    const modelConfig = this.findModelConfig(model);
    if (modelConfig) {
      const providerName = modelConfig.provider || this.config.provider;
      const apiKey = modelConfig.apiKey || this.getApiKey(providerName);
      const baseURL = modelConfig.baseURL
        || (providerName === this.config.provider ? this.config.baseURL : undefined);
      return { model, providerName, apiKey, baseURL: baseURL || undefined };
    }
    // 未找到独立配置 → 沿用主 provider 配置，仅模型名不同（与 getProviderForSubAgent 末路径一致）
    const base = this.getSpawnConfig();
    return { model, providerName: base.providerName, apiKey: base.apiKey, baseURL: base.baseURL };
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
    // ADR-021 §4.4: mock-* 系列名走 MockProvider 工厂
    // 仅 router capability eval 用 (例如 mock-503 / mock-rate-limit / mock-timeout / mock-ok)
    if (providerName.startsWith("mock-")) {
      const { createMockProvider } = require("./mocks/mock-provider.ts");
      const failPattern = (() => {
        const tail = providerName.slice("mock-".length);
        if (tail === "503" || tail === "503-after-3") return "503";
        if (tail.startsWith("503")) return "503";
        if (tail.startsWith("rate-limit")) return "rate_limit";
        if (tail.startsWith("timeout")) return "timeout";
        return "ok";
      })();
      // failAfterRequests 后缀解析: "mock-503-after-2" → 2 次成功后失败
      const afterMatch = providerName.match(/-after-(\d+)$/);
      const failAfterRequests = afterMatch ? parseInt(afterMatch[1], 10) : 0;
      return createMockProvider({
        name: providerName,
        failPattern,
        model: this.config.model,
        failAfterRequests,
      });
    }

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
