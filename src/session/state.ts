/**
 * 会话状态管理 — 单一真相源
 * 对标 Claude Code 的 SessionState，集中管理：
 * - 按模型分开的 token 用量统计
 * - 成本计算（区分缓存 token 计价）
 * - API 耗时 vs 工具耗时分开追踪
 */

import type { Usage, NormalizedCacheUsage } from "../llm/types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";

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

/** 模型定价（每百万 token） */
interface ModelPricing {
  input: number;   // 未命中输入价格 $/M tokens
  output: number;  // 输出价格 $/M tokens
  /**
   * 缓存命中（读）价格 $/M tokens。
   * - Anthropic：= input × 0.1（90% 折扣）
   * - DeepSeek：独立固定价（pro 0.025 元/M → 0.0035 $/M ≈ 未命中的 1/120）
   * 不填时 calculateCost 兜底按 input × 0.1 计（Anthropic 式近似）。
   */
  cacheHit?: number;
  /**
   * 缓存写入价格 $/M tokens。
   * - Anthropic：= input × 1.25（25% 加价，5min TTL）
   * - DeepSeek：无写入计费概念 → 0
   * 不填时 calculateCost 兜底按 input × 1.25 计（Anthropic 式近似）。
   */
  cacheWrite?: number;
}

/** 内置模型定价表（单位：USD / 百万 token） */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 系列（官方 USD/M）；命中 = input×0.1、写入 = input×1.25 由 calculateCost 兜底派生
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-20250514": { input: 0.25, output: 1.25 },
  // 旧版兼容
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  "claude-3-opus-20240229": { input: 15, output: 75 },

  // DeepSeek 系列：官方价为 RMB/M（见 api-reference/deepseek-api.md「模型 & 价格」），
  // 按 1 元 ≈ $0.14 折算成 USD（汇率快照 2026-06，随官方调整需复核）。
  // pro：未命中 3 元 / 输出 6 元 / 命中 0.025 元；flash：未命中 1 元 / 输出 2 元 / 命中 0.02 元。
  // cacheHit 用 DeepSeek 独立固定价（非 input×0.1 近似），更贴近真实账单；
  // cacheWrite=0——DeepSeek 无缓存写入计费概念。
  // 前缀匹配：getPricing 用 startsWith，可命中带后缀的 "deepseek-v4-pro[1m]" 等变体。
  "deepseek-v4-pro": { input: 0.42, output: 0.84, cacheHit: 0.0035, cacheWrite: 0 },   // 3×0.14 / 6×0.14 / 0.025×0.14
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheHit: 0.0028, cacheWrite: 0 },  // 1×0.14 / 2×0.14 / 0.02×0.14

  // OpenAI 系列（官方 USD/M）；OpenAI 命中价 = input×0.5（缓存读 50% 折扣），无写入计费
  "gpt-4o": { input: 2.5, output: 10, cacheHit: 1.25, cacheWrite: 0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheHit: 0.075, cacheWrite: 0 },
};

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

  constructor(sessionId: string, cwd?: string) {
    this.sessionId = sessionId;
    this.cwd = cwd ?? process.cwd();
    this.startTime = Date.now();
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
    const prov = provider ?? SessionState.inferProvider(model);
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
    const pricing = this.getPricing(model);
    if (!pricing) {
      // P1-4：未知模型不静默归零（否则换个模型名费用立刻变 0，costLimit 守卫被绕过，
      // 用户以为"免费"实际在烧钱）。记 WARN 一次（按模型去重），用保守兜底价估算成本，
      // 宁可高估也不归零，让预算守卫继续生效。
      this.warnUnknownPricing(model);
      const prov = provider ?? SessionState.inferProvider(model);
      const n = normalizeCacheUsage(usage, prov);
      const fb = SessionState.FALLBACK_PRICING;
      let cost = 0;
      cost += (n.uncachedInputTokens / 1_000_000) * fb.input;
      cost += (n.cacheHitTokens / 1_000_000) * fb.input * 0.1;
      cost += (n.cacheWriteTokens / 1_000_000) * fb.input * 1.25;
      cost += (n.outputTokens / 1_000_000) * fb.output;
      return cost;
    }

    const prov = provider ?? SessionState.inferProvider(model);
    const n = normalizeCacheUsage(usage, prov);

    // 命中/写入价：优先用定价表显式值，否则按 Anthropic 式近似派生（input×0.1 / input×1.25）
    const cacheHitPrice = pricing.cacheHit ?? pricing.input * 0.1;
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
    const pricing = this.getPricing(model);
    if (!pricing) return 0;
    const prov = provider ?? SessionState.inferProvider(model);
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
   * - claude* → "anthropic"（input_tokens 是未命中余量口径）
   * - 其余（deepseek/gpt/ollama 等）→ "openai"（prompt_tokens 含命中口径）
   * 注：ollama 无缓存字段，归一化后 hit/write 恒 0，归到哪类都不影响结果。
   */
  static inferProvider(model: string): string {
    return /^claude/i.test(model) ? "anthropic" : "openai";
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

  /** 获取模型定价，未知模型返回 null */
  private getPricing(model: string): ModelPricing | null {
    // 精确匹配
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];

    // P1-5：只保留正向前缀匹配（model 以表项 key 开头，命中带后缀的变体
    // 如 "deepseek-v4-pro[1m]"），且取**最长前缀**而非首个命中——
    // 否则 "deepseek-v4-pro" 可能先撞上更短的 key。
    // 去掉 key.startsWith(model) 反向匹配：截断/短模型名（如 "deepseek-v4"）
    // 会错配到表中先定义的更贵表项（"deepseek-v4-pro"），且依赖键顺序、非确定。
    let best: ModelPricing | null = null;
    let bestLen = -1;
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = pricing;
        bestLen = key.length;
      }
    }
    return best;
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
   * 未知模型的保守兜底价（USD/M）。取 Claude Sonnet 量级（input 3 / output 15）作中位偏高估，
   * 命中按 input×0.1、写入按 input×1.25 派生。原则：宁可高估触发预算守卫，也不归零放任烧钱。
   */
  private static readonly FALLBACK_PRICING: { input: number; output: number } = {
    input: 3,
    output: 15,
  };

  /** 获取汇总的 Usage（兼容旧接口） */
  getTotalUsage(): Usage {
    const total: Usage = { inputTokens: 0, outputTokens: 0 };
    for (const stats of Object.values(this.modelUsage)) {
      total.inputTokens += stats.inputTokens;
      total.outputTokens += stats.outputTokens;
      total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + stats.cacheCreationInputTokens;
      total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + stats.cacheReadInputTokens;
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
