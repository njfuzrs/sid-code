/**
 * ProviderRegistry — Provider 工厂 + 缓存 + 子代理模型映射
 * 所有组件通过 registry 按需获取 provider/model，不再持有固定实例
 */

import type { Provider } from "./provider.ts";
import type { Config, ModelConfig } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";
import { ModelAvailabilityService } from "./availability.ts";
import { TokenEstimator } from "./token-estimator.ts";
import { resolvePricing } from "../api/cost-tracker.ts";
import { resolveWireModel, buildWireModelAliasMap } from "./wire-model.ts";
import { buildModelCompatMap } from "./model-compat.ts";
import { resolveAgent } from "../agent/agent-definition.ts";
import type { LanguagePref } from "../config/prompt-lang.ts";
import { isJitContextEnabled } from "../config/jit-context.ts";

/** 子代理模型映射 */
export interface SubAgentModelMap {
  /** 兜底默认：所有未单独指定的子代理类型都用它；未配则跟主模型。
   *  解析优先级：按类型显式配置 > default > 主模型。 */
  default?: string;
  explore?: string; // 代码探索（默认跟 default / 主模型）
  task?: string; // 任务执行（默认跟 default / 主模型）
  plan?: string; // 规划分析（默认跟 default / 主模型）
  summarize?: string; // 摘要总结（默认跟 default / 主模型）
  verify?: string; // 对抗式验证（默认跟 default / 主模型）
  /**
   * 其它 agent 类型（`general-purpose` 及用户自定义 / plugin agent）。
   *
   * 上面几个内置键保留显式声明以获得补全与拼写检查；但 agent registry 是**可扩展**的
   * （getActiveAgentTypes 含 general-purpose 与 .claude/agents 下的自定义 agent），
   * 读取侧 getModelForSubAgent 本就按 string 索引、schema 也按 registry 校验，
   * 唯独这个接口的固定键集偏窄，导致给自定义类型赋值时类型报错。索引签名对齐可扩展现实。
   */
  [agentType: string]: string | undefined;
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
    // §12 P3-1：迁移友好——CC 用户设了 CLAUDE_CODE_SUBAGENT_MODEL 也生效。
    // 仅当未显式配置 subAgentModels.default 时用它填充 default（不覆盖用户显式配置）。
    // sid-code 的 subAgentModels 按类型分级（比 CC 更强），此处只补 default 兜底键。
    const ccSubAgentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim();
    if (ccSubAgentModel && !this.subAgentModels.default) {
      this.subAgentModels = { ...this.subAgentModels, default: ccSubAgentModel };
    }
    this.availability = new ModelAvailabilityService();
  }

  /**
   * 已知可用的模型名清单（去重、保序），用于「模型名白名单校验」。
   *
   * 来源：availableModels 配置 + 主模型 + 降级模型 + subAgentModels 里已配置的值。
   * 后三者也纳入，是因为它们即便没写进 availableModels 也一定是用户有意指定的
   * 合法目标（顶层字段会回填连接信息），不能被判成非法。
   *
   * 背景（2026-08-01 生产事故）：`sub_agent` 的 `model` 参数只有 `z.string()`，
   * 无任何校验。模型臆造了一个不存在的名字 `"deepseek"`（用户配的实际是
   * `ali-deepseek-v4-pro` / `ali-deepseek-v4-flash`）并直接透传给网关，得到
   * `503 model_not_found`。连带两个次生污染：`AGENT_LOOP` 把这个根本不存在的
   * 模型名"跨路径拉黑"，`SESSION` 又用兜底价给它估了成本。
   *
   * 返回空数组表示「无从判断」（用户没配 availableModels），调用方必须 fail-open
   * 放行——绝不能因为清单为空就把所有模型都判为非法。
   */
  getKnownModelNames(): string[] {
    const names: string[] = [];
    const push = (n: string | undefined) => {
      const v = n?.trim();
      if (v && !names.includes(v)) names.push(v);
    };

    for (const m of this.config.availableModels ?? []) push(m.name);
    push(this.config.model);
    push(this.config.fallbackModel);
    for (const v of Object.values(this.subAgentModels)) push(v);

    return names;
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

  /**
   * 获取输出语言偏好（含 auto 档；子代理侧由 resolveEffectiveLanguage 归一化）。
   *
   * 读的是 `this.config`——与 App 共享**同一个对象引用**，所以 `/language` 运行时
   * 切换（`setLanguageRuntime` 改 `config.language`）无需通知 registry 即对新建子代理生效。
   * 这个引用共享是刻意的，不要改成构造时快照拷贝，否则运行时切换只作用于主代理，
   * 子代理仍按旧语言输出。
   */
  getLanguage(): LanguagePref | undefined {
    return this.config.language;
  }

  /**
   * JIT 上下文发现是否启用（默认开启，见 `JIT_CONTEXT_DEFAULT`）。
   *
   * 存在的理由：`SubAgent` 完全不持有 config（`this.config` 全文 0 命中），只持有
   * registry。而 `createJitDiscoverer` 的 `jitDisabled` 参数此前**从无调用点传值**，
   * 于是 `jitContext: false` 对子代理完全无效 —— 「做了但没接到底」。开关必须可信：
   * 一个半失效的开关比没有开关更糟（用户会转而怀疑整套机制）。
   *
   * 与 `getLanguage()` 同构：读的是 `this.config` —— 与 App 共享**同一个对象引用**，
   * 所以运行时改 `config.jitContext` 无需通知 registry 即对新建子代理生效。
   * 这个引用共享是刻意的，**不要改成构造时快照拷贝**，否则运行时切换只作用于主代理。
   */
  getJitContextEnabled(): boolean {
    return isJitContextEnabled(this.config);
  }

  /** 获取用于子进程 spawn 的 Provider 配置（含 API Key — 仅调用方通过管道传递） */
  getSpawnConfig(): { providerName: string; apiKey: string; baseURL?: string } {
    return {
      providerName: this.config.provider,
      apiKey: this.getApiKey(this.config.provider),
      baseURL: this.config.baseURL || undefined,
    };
  }

  /**
   * 获取子代理模型。
   *
   * 优先级（P0-1/P0-2 补全后）：
   *   1. subAgentModels[type]     —— 用户按类型显式配置（最高，永远优先于任何默认）
   *   2. subAgentModels.default   —— 用户兜底默认
   *   3. agentDef.model           —— agent 定义/frontmatter 声明的 model（P0-2 自定义 agent）
   *   4. modelTier 档位映射        —— 语义档位派生（P0-1，explore/plan/summarize=cheap）
   *   5. this.config.model        —— 主模型兜底（fail-open，绝不因配错更贵或报错）
   *
   * 注意：task.model（每次调用覆盖）在调用方 sub-agent.ts 层处理，优先级高于本方法的全部返回值。
   */
  getModelForSubAgent(type: string): string {
    // 1 + 2：用户配置（按类型 > default）——永远优先，保留用户完全控制权。
    const userConfigured =
      this.subAgentModels[type as keyof SubAgentModelMap] || this.subAgentModels.default;
    if (userConfigured) return userConfigured;

    // 3 + 4：agent 定义驱动（frontmatter model > 语义档位）。resolveAgent 覆盖 built-in + custom + plugin。
    const def = (() => {
      try {
        return resolveAgent(type);
      } catch {
        return undefined;
      }
    })();
    if (def) {
      // 3：frontmatter/定义显式 model（P0-2）。"inherit" 已在解析层归一为不设，此处非空即用。
      if (def.model && def.model.trim()) return def.model.trim();
      // 4：语义档位映射（P0-1）。仅 cheap/strong 尝试派生；default 或未设直接落主模型。
      if (def.modelTier && def.modelTier !== "default") {
        const tierModel = this.resolveModelForTier(def.modelTier);
        if (tierModel) return tierModel;
      }
    }

    // 5：主模型兜底。
    return this.config.model;
  }

  /**
   * 语义档位 → 实际模型名派生（P0-1）。
   *
   * 不硬编码模型名单（铁律 feedback-no-hardcoded-model-tier-rules）。派生来源按优先级：
   *   1. 环境变量 SID_CHEAP_MODEL / SID_STRONG_MODEL（用户显式指定，最高权威）
   *   2. availableModels 按 input 价排序：cheap=最便宜、strong=最贵（且不同于主模型档位）
   *   3. 派生不出（无 availableModels / 无定价 / 只有主模型自己）→ null，调用方 fail-open 回退主模型
   *
   * 绝不返回比主模型更贵的 cheap 档，也绝不因派生失败报错。
   */
  private resolveModelForTier(tier: "cheap" | "strong"): string | null {
    // 1：环境变量显式指定。
    const envName = tier === "cheap" ? "SID_CHEAP_MODEL" : "SID_STRONG_MODEL";
    const envModel = process.env[envName]?.trim();
    if (envModel) return envModel;

    // 2：从 availableModels 按价格派生。无配置模型列表时无从派生。
    const models = this.config.availableModels;
    if (!models || models.length === 0) return null;

    // 为每个候选模型解析 input 单价（USD/M），过滤解析不出价格的。
    const priced: Array<{ name: string; input: number }> = [];
    for (const m of models) {
      if (!m.name) continue;
      const pricing = resolvePricing(m.name, models, m.baseURL);
      if (pricing && pricing.input > 0) {
        priced.push({ name: m.name, input: pricing.input });
      }
    }
    if (priced.length === 0) return null;

    // 主模型的价格作为参照：cheap 档必须严格更便宜，strong 档必须严格更贵，否则宁可回退主模型。
    const mainPricing = resolvePricing(this.config.model, models, this.config.baseURL);
    const mainInput = mainPricing && mainPricing.input > 0 ? mainPricing.input : null;

    if (tier === "cheap") {
      // 取最便宜的一个；若比主模型贵/相等则不派生（回退主模型，绝不更贵）。
      const cheapest = priced.reduce((a, b) => (b.input < a.input ? b : a));
      if (cheapest.name === this.config.model) return null;
      if (mainInput !== null && cheapest.input >= mainInput) return null;
      return cheapest.name;
    } else {
      // strong：取最贵的一个；若不比主模型贵则不派生。
      const strongest = priced.reduce((a, b) => (b.input > a.input ? b : a));
      if (strongest.name === this.config.model) return null;
      if (mainInput !== null && strongest.input <= mainInput) return null;
      return strongest.name;
    }
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
    /** 厂商真名，随 init 过管道给子进程（子进程别名表为空，必须由父进程解析）*/
    wireModel: string;
    /**
     * **完整**别名表，随 init 过管道播种进子进程。
     *
     * 单条 wireModel 只覆盖「本次要发的模型」；子进程里 ModelFallback 降级会**换模型**，
     * 那条路径靠进程级别名表翻译新目标（fallback.ts 刻意置 wireModel=undefined）。
     * 只播种主模型一条 → fallback 目标查不到 → 原样发别名 → 400，而降级正是
     * 主模型已出问题时的最后一道防线。见 sub-agent-protocol.ts 的 wire_model_aliases。
     */
    wireModelAliases?: Record<string, string>;
    /**
     * **完整** compat 表，随 init 过管道播种进子进程。
     *
     * 与上面 wireModelAliases 逐条同理：子进程不读配置文件，进程级 compat 表默认为空；
     * 不播种则用户的协议能力声明在子代理里静默失效（父按声明发、子按内置判定发，
     * 同一份配置两种行为且不报错）。整张表而非单条，同样是为了 fallback 换模型后仍有声明可查。
     */
    modelCompat?: Record<string, unknown>;
    providerName: string;
    apiKey: string;
    baseURL?: string;
  } {
    const model = this.getModelForSubAgent(type);
    // 别名 → 真名：spawn 出的子进程不读配置、别名表为空，只能靠父进程在这里解析后传过去。
    const wireModel = resolveWireModel(model, this.config.availableModels);
    // 整张表（含 fallback 目标等「本次不发但子进程内可能切过去」的别名）。
    // 直接从 availableModels 构造，不读父进程的全局表——后者依赖 resolveCurrentModelConfig
    // 已跑过，而本方法可能在任何时机被调；从配置现算是唯一不依赖调用时序的口径。
    const wireModelAliases = buildWireModelAliasMap(this.config.availableModels);
    // compat 声明表。同样从配置现算而不读全局表——理由与上面 wireModelAliases 完全相同
    // （本方法可能在 resolveCurrentModelConfig 之前的任何时机被调）。
    const modelCompat = buildModelCompatMap(this.config.availableModels);
    // 子代理模型与主模型相同 → 复用主 spawn 配置
    if (model === this.config.model) {
      const base = this.getSpawnConfig();
      return {
        model,
        wireModel,
        wireModelAliases,
        modelCompat,
        providerName: base.providerName,
        apiKey: base.apiKey,
        baseURL: base.baseURL,
      };
    }
    // 子代理模型在 availableModels 中有独立配置 → 用其 provider/apiKey/baseURL
    const modelConfig = this.findModelConfig(model);
    if (modelConfig) {
      const providerName = modelConfig.provider || this.config.provider;
      const apiKey = modelConfig.apiKey || this.getApiKey(providerName);
      const baseURL =
        modelConfig.baseURL ||
        (providerName === this.config.provider ? this.config.baseURL : undefined);
      return {
        model,
        wireModel,
        wireModelAliases,
        modelCompat,
        providerName,
        apiKey,
        baseURL: baseURL || undefined,
      };
    }
    // 未找到独立配置 → 沿用主 provider 配置，仅模型名不同（与 getProviderForSubAgent 末路径一致）
    const base = this.getSpawnConfig();
    return {
      model,
      wireModel,
      wireModelAliases,
      modelCompat,
      providerName: base.providerName,
      apiKey: base.apiKey,
      baseURL: base.baseURL,
    };
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
      const baseURL =
        modelConfig.baseURL || (providerName === this.config.provider ? this.config.baseURL : "");
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
    return this.config.availableModels?.find((m) => m.name === modelName);
  }

  /**
   * 把任意本地别名解析成厂商真名（缺省回落别名本身）。
   *
   * 存在意义：**跨进程**场景需要父进程代为解析。spawn 出的子代理是独立 OS 进程，
   * 不读 settings.json、不跑 loadConfig，其进程级别名表恒为空，只能由父进程把真名
   * 随 init 消息传过去（见 sub-agent-protocol.ts 的 wire_model）。
   * 进程内路径不需要调它 —— provider 侧的 pickWireModel 会自动走别名表。
   */
  resolveWireModelForAlias(alias: string): string {
    return resolveWireModel(alias, this.config.availableModels);
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
    // 缺陷清单 P2-11 录制回放（VCR）：provider 名 "replay" + 环境变量指定录制文件。
    //
    // 为什么要让它从 registry 走通，而不是只做一个测试里 new 出来的类：
    // 本清单 7/11 条缺陷是同一个病——「代码完整、测试通过、调用点为零」。回放器若只能
    // 在单测里手动 new，它对**主循环全链路**的复现能力就是零（而那才是它的价值），
    // 形态与 P0-3（OtlpExporter 写完但配置层不可达）完全一致。所以这里接上入口：
    //
    //   SID_CODE_REPLAY_FILE=~/.sid-code/trajectories/sessions/<id>/raw.jsonl \
    //     sid-code --provider replay
    //
    // 注意它**只读本地文件、不发任何网络请求**，所以没有 apiKey 校验。
    if (providerName === "replay") {
      const file = process.env.SID_CODE_REPLAY_FILE;
      if (!file) {
        throw new Error(
          "provider=replay 需要环境变量 SID_CODE_REPLAY_FILE 指向一个 raw.jsonl 录制文件",
        );
      }
      const { ReplayProvider } = require("./mocks/replay-provider.ts");
      // 耗尽行为默认 end-turn：从 CLI 跑回放时，录制放完就让主循环自然收尾，
      // 比抛错更符合"重放一次会话看看"的直觉。测试里需要严格轮数断言的自己 new。
      const onExhausted = process.env.SID_CODE_REPLAY_ON_EXHAUSTED ?? "end-turn";
      return ReplayProvider.fromFileSync(file, { onExhausted });
    }

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
