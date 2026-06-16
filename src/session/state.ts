/**
 * 会话状态管理 — 单一真相源
 * 对标 Claude Code 的 SessionState，集中管理：
 * - 按模型分开的 token 用量统计
 * - 成本计算（区分缓存 token 计价）
 * - API 耗时 vs 工具耗时分开追踪
 *
 * 定价来源：统一委托给 cost-tracker.ts 的 resolvePricing()，不维护独立定价表。
 */

import type { Usage, NormalizedCacheUsage } from "../llm/types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";
import { resolvePricing, type PricingModelEntry } from "../api/cost-tracker.ts";

/** 单个模型的用量统计 */
export interface ModelUsageStats {
  /**
   * 末次输入 token（stock 口径）：= 最后一次 API 调用的 prompt 总长度（含全部历史）。
   * 因含历史，累加会 N² 过计数，故取末次。**仅用于上下文窗口占比展示**。
   * 命中率/计费等 flow 统计请用 {@link cumulativePromptTokens}。
   */
  inputTokens: number;
  /**
   * 累计输入 token（flow 口径）：每次 API 调用的 inputTokens 之和。
   * - Anthropic：每次的未命中余量之和 → 累计未命中。
   * - OpenAI/DeepSeek：每次的 prompt_tokens 之和 → 累计完整输入。
   * 与 cacheRead/cacheCreation（同为 flow 累加）口径一致，供命中率/省钱统计。
   */
  cumulativePromptTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  requests: number;
  costUSD: number;
  /** 缓存节省金额（美元）：假设全部按未命中全价 − 实际成本，逐次累加 */
  cacheSavingsUSD: number;
  /** 该模型对应的 provider（"anthropic"/"openai"/...），用于归一化口径区分 */
  provider: string;
}

/** 会话状态 */
export class SessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly startTime: number;

  /** 总花费（美元） */
  totalCostUSD: number = 0;
  /** API 调用总耗时（毫秒） */
  totalAPIDuration: number = 0;
  /** 工具执行总耗时（毫秒） */
  totalToolDuration: number = 0;
  /** 按模型分开的用量统计 */
  modelUsage: Record<string, ModelUsageStats> = {};
  /** 会话级别的临时数据存储（用于命令间共享状态） */
  private sessionData = new Map<string, any>();
  /** 用户配置的模型列表（携带定价 + provider 信息），用于定价/inferProvider 优先使用 */
  private availableModels: PricingModelEntry[] = [];

  constructor(sessionId: string, cwd?: string) {
    this.sessionId = sessionId;
    this.cwd = cwd ?? process.cwd();
    this.startTime = Date.now();
  }

  /** 注入用户配置的模型列表（含 pricing/provider），供定价解析和 provider 推断优先使用 */
  setAvailableModels(models: PricingModelEntry[]): void {
    this.availableModels = models;
  }

  /** 获取会话数据 */
  get(key: string): any {
    return this.sessionData.get(key);
  }

  /** 设置会话数据 */
  set(key: string, value: any): void {
    this.sessionData.set(key, value);
  }

  /** 删除会话数据 */
  delete(key: string): boolean {
    return this.sessionData.delete(key);
  }

  /** 检查会话数据是否存在 */
  has(key: string): boolean {
    return this.sessionData.has(key);
  }

  /** 更新 API 调用的用量统计 */
  updateUsage(model: string, usage: Usage, durationMs: number, provider?: string): void {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);
    // 初始化模型统计
    if (!this.modelUsage[model]) {
      this.modelUsage[model] = {
        inputTokens: 0,
        cumulativePromptTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        requests: 0,
        costUSD: 0,
        cacheSavingsUSD: 0,
        provider: prov,
      };
    }

    const stats = this.modelUsage[model];
    stats.provider = prov; // 末次 provider 覆盖（同模型 provider 稳定，覆盖无害）

    // 累加 token
    // ⚠️ usage.inputTokens 是"本次 API 调用时的 prompt 总长度"（含全部历史），
    // 累加会 N² 过计数。inputTokens 取最后一次（stock，给上下文占比展示）；
    // cumulativePromptTokens 累加（flow，给命中率/省钱统计，与 cacheRead 累加口径一致）。
    // 校准记录见 evals/eval-judge.ts gradeCost 注释。
    stats.inputTokens = usage.inputTokens;
    stats.cumulativePromptTokens += usage.inputTokens;
    stats.outputTokens += usage.outputTokens;
    stats.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    stats.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    stats.requests += 1;

    // 计算本次成本（带 provider 口径）
    const cost = this.calculateCost(model, usage, prov);
    stats.costUSD += cost;

    // 累加缓存节省（全价假设 − 实际）
    stats.cacheSavingsUSD += this.calculateSavings(model, usage, prov);

    // 更新全局统计
    this.totalCostUSD += cost;
    this.totalAPIDuration += durationMs;
  }

  /** 累加工具执行耗时 */
  addToolDuration(durationMs: number): void {
    this.totalToolDuration += durationMs;
  }

  /**
   * 计算单次 API 调用的成本（方案 §2.3 口径修复）。
   *
   * **修复前的 bug**：旧实现用 `regularInput = inputTokens − cacheRead − cacheCreation`，
   * 对 Anthropic 会重复扣减——Anthropic 的 inputTokens 本就是未命中余量，再减一次导致
   * regularInput 偏小、费用算低。
   *
   * **修复后**：统一经 {@link normalizeCacheUsage} 归一化为互斥三段后分别计价，不再做减法。
   * 两家口径都正确：
   * - 未命中：uncachedInputTokens × pricing.input（全价）
   * - 命中：cacheHitTokens × pricing.cacheHit（DeepSeek 固定价 / Anthropic = input×0.1 兜底）
   * - 写入：cacheWriteTokens × pricing.cacheWrite（DeepSeek=0 / Anthropic = input×1.25 兜底）
   * - 输出：outputTokens × pricing.output
   *
   * @param model 模型名
   * @param usage 原始用量
   * @param provider provider 名（"anthropic"/"openai"/...）。不传时按模型名推断（claude* → anthropic）。
   */
  calculateCost(model: string, usage: Usage, provider?: string): number {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);

    // 本地推理 provider（ollama 等）不产生真金白银费用，恒 0。
    // 否则其模型名不在定价表 → 走 FALLBACK_PRICING 被算出虚高费用，
    // 还会误触 costLimit 守卫中断本地会话（本地跑大上下文尤甚）。
    if (SessionState.isLocalProvider(prov)) {
      return 0;
    }

    const pricing = resolvePricing(model, this.availableModels);
    if (!pricing) {
      // P1-4：未知模型不静默归零（否则换个模型名费用立刻变 0，costLimit 守卫被绕过，
      // 用户以为"免费"实际在烧钱）。记 WARN 一次（按模型去重），用保守兜底价估算成本，
      // 宁可高估也不归零，让预算守卫继续生效。
      this.warnUnknownPricing(model);
      const n = normalizeCacheUsage(usage, prov);
      const fb = SessionState.FALLBACK_PRICING;
      let cost = 0;
      cost += (n.uncachedInputTokens / 1_000_000) * fb.input;
      cost += (n.cacheHitTokens / 1_000_000) * fb.input * 0.1;
      cost += (n.cacheWriteTokens / 1_000_000) * fb.input * 1.25;
      cost += (n.outputTokens / 1_000_000) * fb.output;
      return cost;
    }

    const n = normalizeCacheUsage(usage, prov);

    // 命中/写入价：优先用定价表显式值，否则按 Anthropic 式近似派生（input×0.1 / input×1.25）
    const cacheHitPrice = pricing.cacheRead ?? pricing.input * 0.1;
    const cacheWritePrice = pricing.cacheWrite ?? pricing.input * 1.25;

    let cost = 0;
    cost += (n.uncachedInputTokens / 1_000_000) * pricing.input;   // 未命中全价
    cost += (n.cacheHitTokens / 1_000_000) * cacheHitPrice;         // 命中
    cost += (n.cacheWriteTokens / 1_000_000) * cacheWritePrice;     // 写入
    cost += (n.outputTokens / 1_000_000) * pricing.output;          // 输出

    return cost;
  }

  /**
   * 计算单次调用的缓存节省金额（美元）= 假设全部按未命中全价 − 实际成本。
   * 全价假设：把 promptTotal 全部当未命中输入计价。
   */
  calculateSavings(model: string, usage: Usage, provider?: string): number {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);
    // 本地 provider 无费用 → 无"节省"概念，恒 0
    if (SessionState.isLocalProvider(prov)) return 0;
    const pricing = resolvePricing(model, this.availableModels);
    if (!pricing) return 0;
    const n = normalizeCacheUsage(usage, prov);
    // 全价成本：promptTotal 全按未命中输入 + 输出
    const hypothetical =
      (n.promptTotal / 1_000_000) * pricing.input +
      (n.outputTokens / 1_000_000) * pricing.output;
    const actual = this.calculateCost(model, usage, prov);
    return Math.max(0, hypothetical - actual);
  }

  /**
   * 按模型名推断 provider，供 calculateCost 在调用方未显式传 provider 时兜底。
   *
   * 优先级：
   *   1. availableModels 中同名模型的 provider 字段（权威，用户配置）
   *   2. 内置启发式：模型名 claude* → "anthropic"；其余 → "openai"
   *   注：ollama 无缓存字段，归一化后 hit/write 恒 0，归到哪类都不影响结果。
   */
  static inferProvider(model: string, availableModels?: PricingModelEntry[]): string {
    // 优先从用户配置的 availableModels 中查找
    if (availableModels?.length) {
      const mc = availableModels.find(m => m.name === model);
      if (mc?.provider) return mc.provider;
    }
    // 兜底启发式
    return /^claude/i.test(model) ? "anthropic" : "openai";
  }

  /**
   * 判定是否本地推理 provider（不产生 API 费用）。
   *
   * 仅凭模型名无法识别（ollama 跑 llama3 等会被 inferProvider 归为 "openai"），
   * 必须依赖显式传入的 provider 名。本地 provider 计费/节省恒 0，避免 FALLBACK_PRICING
   * 把免费的本地推理算成真金白银、误触 costLimit。
   */
  static isLocalProvider(provider: string | undefined): boolean {
    if (!provider) return false;
    const p = provider.toLowerCase();
    return p === "ollama" || p === "local" || p === "llamacpp" || p === "lmstudio";
  }

  /**
   * 汇总全会话的归一化缓存视图（跨所有模型累加三段）。
   * 供 Footer 命中率列、会话摘要、SessionEnd 账本使用——单一事实源。
   */
  getNormalizedCacheUsage(): NormalizedCacheUsage {
    const total: NormalizedCacheUsage = {
      cacheHitTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      promptTotal: 0,
    };
    for (const stats of Object.values(this.modelUsage)) {
      const n = normalizeCacheUsage(
        {
          // ⚠️ 必须用 cumulativePromptTokens（flow）而非 inputTokens（stock）。
          // 命中数 cacheReadInputTokens 是累加值；若输入用末次值，
          // OpenAI/DeepSeek 口径 uncached = max(0, input − hit) 会被钳到 0
          // （多轮后累加命中可达 80k+ 远超末次输入 ~18k），命中率虚高、省钱失真。
          inputTokens: stats.cumulativePromptTokens,
          outputTokens: stats.outputTokens,
          cacheReadInputTokens: stats.cacheReadInputTokens,
          cacheCreationInputTokens: stats.cacheCreationInputTokens,
        },
        stats.provider,
      );
      total.cacheHitTokens += n.cacheHitTokens;
      total.cacheWriteTokens += n.cacheWriteTokens;
      total.uncachedInputTokens += n.uncachedInputTokens;
      total.outputTokens += n.outputTokens;
      total.promptTotal += n.promptTotal;
    }
    return total;
  }

  /** 全会话累计缓存节省金额（美元） */
  getTotalCacheSavings(): number {
    let sum = 0;
    for (const stats of Object.values(this.modelUsage)) {
      sum += stats.cacheSavingsUSD;
    }
    return sum;
  }

  /** 已告警过的未知模型（按模型名去重，避免每次调用刷屏） */
  private warnedUnknownModels = new Set<string>();

  /** 对未知定价模型记一次 WARN（去重） */
  private warnUnknownPricing(model: string): void {
    if (this.warnedUnknownModels.has(model)) return;
    this.warnedUnknownModels.add(model);
    getLogger().warn(
      "SESSION",
      `模型 "${model}" 不在定价表中，已用保守兜底价（input $${SessionState.FALLBACK_PRICING.input}/M、output $${SessionState.FALLBACK_PRICING.output}/M）估算成本。` +
        `如需精确计费，请在定价表或 availableModels 配置中补充该模型价格。`,
    );
  }

  /**
   * 未知模型的保守兜底价（USD/M）。不绑定任何特定模型品牌，取中位偏高值
   * （input $2 / output $10），介于低价模型与高价模型之间。
   * 命中按 input×0.1、写入按 input×1.25 派生。原则：宁可高估触发预算守卫，也不归零放任烧钱。
   */
  private static readonly FALLBACK_PRICING: { input: number; output: number } = {
    input: 2,
    output: 10,
  };

  /**
   * 获取汇总的 Usage（兼容旧接口）。
   *
   * DISP-1 FIX：inputTokens 改为 flow 累计口径（cumulativePromptTokens），
   * 与 cacheReadInputTokens 累加口径一致，确保 deriveCacheMetrics 的命中率计算分母正确。
   * 此前用 stock 末次值（stats.inputTokens = 每次覆盖仅保留末次），导致分子（flow 累计）≫ 分母（stock 末次），
   * 命中率经常 >100% 甚至飙升到几千 %。
   */
  getTotalUsage(): Usage {
    const total: Usage = { inputTokens: 0, outputTokens: 0 };
    for (const stats of Object.values(this.modelUsage)) {
      total.inputTokens += stats.cumulativePromptTokens;
      total.outputTokens += stats.outputTokens;
      total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + stats.cacheCreationInputTokens;
      total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + stats.cacheReadInputTokens;
    }
    return total;
  }

  /**
   * 累计输入 prompt token（flow 口径，各模型 cumulativePromptTokens 之和）。
   * DISP-1：与逐次累加的 totalCostUSD 口径可比（"花了多少钱 ↔ 累计喂了多少 token"）。
   * getTotalUsage().inputTokens 现也已改为 flow 累计口径，与此方法一致。
   */
  getCumulativePromptTokens(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.cumulativePromptTokens;
    }
    return total;
  }

  /**
   * 获取末次输入 token（stock 口径，各模型 stats.inputTokens 之和）。
   *
   * stats.inputTokens 每次 API 调用时被覆盖为当次 prompt 总长度（不含历史重复计数），
   * 与 getTotalUsage().inputTokens（flow 累计）不同：
   * - **stock**：末次单次调用的 prompt 大小，适合"当前上下文有多大"的展示（如状态栏输入 token）
   * - **flow**：历次调用的 cumulativePromptTokens 之和，适合命中率/计费统计
   *
   * 多模型会话场景：各模型 stock 值简单求和，实践中绝大多数会话只有单一模型。
   */
  getStockInputTokens(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.inputTokens;
    }
    return total;
  }

  /** 获取会话运行时长（毫秒） */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** 格式化耗时为可读字符串 */
  static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${minutes}m${remainSeconds}s`;
  }
}
