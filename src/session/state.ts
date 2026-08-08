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
   * 末次输入 token（stock 口径，**provider 原始口径**）：= 最后一次 API 调用的 `usage.inputTokens`。
   * ⚠️ 口径因 provider 而异：Anthropic = 未命中余量（不含命中/写入），OpenAI/DeepSeek = 含命中的全量 prompt。
   * 因此**不要**直接用它展示「当前上下文大小」——对 Anthropic 会严重低估（只剩 cache miss 增量）。
   * 展示当前上下文请用 {@link stockPromptTokens}（已归一化为末次完整输入）。
   * 命中率/计费等 flow 统计请用 {@link cumulativePromptTokens}。
   */
  inputTokens: number;
  /**
   * 末次完整输入 token（stock 口径，**归一化后的 promptTotal**）：每次 API 调用覆盖写入
   * `normalizeCacheUsage(usage, provider).promptTotal`，即末次调用的 uncached + hit + write 之和。
   * - Anthropic：input_tokens（未命中余量）+ cache_read + cache_creation = 真实末次上下文。
   * - OpenAI/DeepSeek：prompt_tokens（本就含命中）= 完整上下文。
   * 两家统一为「末次完整 prompt 大小」，**这才是状态栏「输入」该显示的口径**（反映当前上下文有多大）。
   */
  stockPromptTokens: number;
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

/**
 * 用量统计的可持久化快照（写入会话 JSONL 的 usage_stats metadata，resume 时回灌）。
 * 覆盖 Footer 状态栏展示所需全部维度——恢复对话后 token/费用/缓存节省不再从 0 起。
 */
export interface UsageSnapshot {
  totalCostUSD: number;
  sideCostUSD: number;
  totalAPIDuration: number;
  totalToolDuration: number;
  modelUsage: Record<string, ModelUsageStats>;
}

/** 会话状态 */
export class SessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly startTime: number;

  /** 总花费（美元） */
  totalCostUSD: number = 0;
  /**
   * 辅助调用（side call）花费（美元）——标题生成/记忆召回/bash分类/摘要压缩/缓存预热等
   * 不经主循环的影子调用。与 totalCostUSD 分开累加，避免污染 traj 的 total/side 分离语义。
   * 展示层（TUI 费用列 / /cost）和 quota 守卫读 totalCostUSD + sideCostUSD = 真实总花费。
   * 注意：辅助调用的 token 不并入 modelUsage，避免污染 stock 口径（"当前上下文大小"展示）。
   */
  sideCostUSD: number = 0;
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
  /**
   * 缺口7：会话累计轮次（**不随用户消息重置**）。
   *
   * 根因：`LoopState.turnCount` 由 `createInitialLoopState` 在每条用户消息（每次
   * `queryLoop` 调用）时新建 → 每条消息从 0 重数，而 `AfterModel.data.index` 是会话
   * 累计。两个口径此前都以 `turn` 之名落进 events.jsonl，导致跨消息会话里"这条假设
   * 存活了多久""登记发生在会话哪个阶段"这类问题**无法回答且不会报错**——只会静静
   * 给出错误结论（设计文档 §2.3 初稿把 44 轮写成 52 轮，就是直接把两个计数器相减）。
   *
   * 埋点侧的正确做法是同时落两个字段：`turn`（消息内，保留兼容）+ `absoluteTurn`
   * （本字段）+ `promptSeq`（第几条用户消息），让 `turn=3` 可还原到具体哪条消息。
   */
  private absoluteTurnCount = 0;
  /** 缺口7：第几条用户消息（每次 queryLoop 启动 +1，从 1 开始）。 */
  private promptSeq = 0;

  constructor(sessionId: string, cwd?: string) {
    this.sessionId = sessionId;
    this.cwd = cwd ?? process.cwd();
    this.startTime = Date.now();
  }

  /**
   * 缺口7：递增会话累计轮次并返回新值（queryLoop 每轮 turnCount++ 时同步调用）。
   *
   * 与 `LoopState.turnCount++` 严格同点调用，保证两个计数器同步推进——否则
   * absoluteTurn 会漂移，而漂移的绝对轮次比没有绝对轮次更糟（前者会被当真）。
   */
  nextAbsoluteTurn(): number {
    this.absoluteTurnCount += 1;
    return this.absoluteTurnCount;
  }

  /** 缺口7：读当前会话累计轮次（不递增），供埋点补齐 absoluteTurn。 */
  getAbsoluteTurn(): number {
    return this.absoluteTurnCount;
  }

  /**
   * 缺口7：递增用户消息序号并返回新值（queryLoop 启动时调用一次）。
   *
   * resume 场景刻意**不**回灌：resume 后 promptSeq 从 1 重数，但 events.jsonl 里
   * session_id 相同、时间戳单调，离线分析仍可按"文件内出现顺序 + promptSeq 回绕点"
   * 切分。回灌反而要引入一份新的持久化状态，成本高于收益。
   */
  nextPromptSeq(): number {
    this.promptSeq += 1;
    return this.promptSeq;
  }

  /** 缺口7：读当前用户消息序号（不递增）。 */
  getPromptSeq(): number {
    return this.promptSeq;
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
  updateUsage(model: string, usage: Usage, durationMs: number, provider?: string, baseURL?: string): void {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);
    // 初始化模型统计
    if (!this.modelUsage[model]) {
      this.modelUsage[model] = {
        inputTokens: 0,
        stockPromptTokens: 0,
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
    // 累加会 N² 过计数。inputTokens 取最后一次（stock，provider 原始口径）；
    // stockPromptTokens 取最后一次的归一化完整输入（uncached+hit+write，跨 provider 统一，给上下文占比展示）；
    // cumulativePromptTokens 累加（flow，给命中率/省钱统计，与 cacheRead 累加口径一致）。
    // 校准记录见 evals/eval-judge.ts gradeCost 注释。
    stats.inputTokens = usage.inputTokens;
    stats.stockPromptTokens = normalizeCacheUsage(usage, prov).promptTotal;
    stats.cumulativePromptTokens += usage.inputTokens;
    stats.outputTokens += usage.outputTokens;
    stats.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    stats.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    stats.requests += 1;

    // 计算本次成本（带 provider 口径 + 端点精确价）
    const cost = this.calculateCost(model, usage, prov, baseURL);
    stats.costUSD += cost;

    // 累加缓存节省（全价假设 − 实际）
    stats.cacheSavingsUSD += this.calculateSavings(model, usage, prov, baseURL);

    // 更新全局统计
    this.totalCostUSD += cost;
    this.totalAPIDuration += durationMs;
  }

  /** 累加工具执行耗时 */
  addToolDuration(durationMs: number): void {
    this.totalToolDuration += durationMs;
  }

  /**
   * 重置累计计数器（/clear 时调用）。
   * 清空 totalCostUSD、totalAPIDuration、totalToolDuration 和所有 modelUsage，
   * 使状态栏的 token/费用/缓存命中等统计归零，与清空的对话上下文保持一致。
   */
  resetCounters(): void {
    this.totalCostUSD = 0;
    this.sideCostUSD = 0;
    this.totalAPIDuration = 0;
    this.totalToolDuration = 0;
    this.modelUsage = {};
  }

  /**
   * 重置 reminder 通道的跨轮去重/基线键（/clear 时调用）。
   *
   * 这些键挂在 sessionData 上是**故意的**——它们必须跨用户消息存活，否则每条新消息
   * 都会重建、去重形同白做（见 loop.ts 里 announcedDeferredTools / lastSeenPermissionMode
   * 的注释，都踩过"挂 LoopState 导致每条消息归零"的坑）。
   *
   * 但"跨消息"不等于"跨 /clear"：`/clear` 清空了对话历史，模型对之前播报过的
   * 延迟工具列表、权限模式提醒完全失忆，而去重键还记着"已经告诉过它了" →
   * 新一轮对话里**永远不再播报**，延迟工具机制在 /clear 后彻底失效。
   * 这与 compact 路径的 deferredToolsPendingAfterCompact 是同一类问题，
   * compact 已处理，/clear 此前漏了（2026-07-30 重复注入根因修复时发现）。
   *
   * `resetCounters()` 只动用量统计、不碰 sessionData，故单独一个方法；
   * 两处 /clear 分支（斜杠命令结构化结果 / 旧 switch 分支）都必须调用。
   */
  resetReminderDedupKeys(): void {
    this.sessionData.delete("announcedDeferredTools");
    this.sessionData.delete("lastSeenPermissionMode");
    this.sessionData.delete("lastSeenContextPressureLevel");
  }

  /**
   * 累加辅助调用花费（影子调用：标题生成/记忆召回/bash分类/摘要压缩/缓存预热等）。
   * 只累加费用，不并入 modelUsage（避免污染 stock 口径的"当前上下文大小"展示）。
   * 由 side-call-sink 在每次 recordSideCall 时回调。
   */
  addSideCost(costUSD: number): void {
    this.sideCostUSD += costUSD;
  }

  /**
   * 序列化当前用量统计为可持久化快照（用于会话落盘 + resume 恢复）。
   *
   * 覆盖 Footer 状态栏展示所需的全部维度：
   * - 各模型的 modelUsage（token 三口径 / cache / cost / cacheSavings / provider）——
   *   getTotalUsage / getStockPromptTokens / getTotalCacheSavings 全部从这里派生。
   * - 全局 totalCostUSD / sideCostUSD——getEffectiveTotalCostUSD（费用列）从这里派生。
   * - totalAPIDuration / totalToolDuration——供耗时展示恢复。
   *
   * 注意：不含 sessionData（临时数据）、availableModels（启动时注入）、
   * warnedUnknownModels（去重集，无需跨会话保留）——这些要么会被重新注入，要么无展示意义。
   */
  serializeUsageSnapshot(): UsageSnapshot {
    return {
      totalCostUSD: this.totalCostUSD,
      sideCostUSD: this.sideCostUSD,
      totalAPIDuration: this.totalAPIDuration,
      totalToolDuration: this.totalToolDuration,
      modelUsage: JSON.parse(JSON.stringify(this.modelUsage)) as Record<string, ModelUsageStats>,
    };
  }

  /**
   * 从持久化快照回灌用量统计（resume 恢复路径调用）。
   *
   * 直接覆盖当前累计值——resume 时 SessionState 是全新零值实例，覆盖等价于「继续之前的
   * 累计」。回灌后后续 updateUsage 会在此基础上继续累加，Footer 展示连续不断档。
   *
   * 容错：快照缺字段/类型不符时按零值兜底，绝不因脏快照抛错阻断恢复。
   */
  hydrateUsage(snapshot: UsageSnapshot | undefined | null): void {
    if (!snapshot || typeof snapshot !== "object") return;
    this.totalCostUSD = typeof snapshot.totalCostUSD === "number" ? snapshot.totalCostUSD : 0;
    this.sideCostUSD = typeof snapshot.sideCostUSD === "number" ? snapshot.sideCostUSD : 0;
    this.totalAPIDuration = typeof snapshot.totalAPIDuration === "number" ? snapshot.totalAPIDuration : 0;
    this.totalToolDuration = typeof snapshot.totalToolDuration === "number" ? snapshot.totalToolDuration : 0;
    const restored: Record<string, ModelUsageStats> = {};
    const src = snapshot.modelUsage;
    if (src && typeof src === "object") {
      for (const [model, s] of Object.entries(src)) {
        if (!s || typeof s !== "object") continue;
        restored[model] = {
          inputTokens: Number((s as ModelUsageStats).inputTokens) || 0,
          stockPromptTokens: Number((s as ModelUsageStats).stockPromptTokens) || 0,
          cumulativePromptTokens: Number((s as ModelUsageStats).cumulativePromptTokens) || 0,
          outputTokens: Number((s as ModelUsageStats).outputTokens) || 0,
          cacheReadInputTokens: Number((s as ModelUsageStats).cacheReadInputTokens) || 0,
          cacheCreationInputTokens: Number((s as ModelUsageStats).cacheCreationInputTokens) || 0,
          requests: Number((s as ModelUsageStats).requests) || 0,
          costUSD: Number((s as ModelUsageStats).costUSD) || 0,
          cacheSavingsUSD: Number((s as ModelUsageStats).cacheSavingsUSD) || 0,
          provider: typeof (s as ModelUsageStats).provider === "string" ? (s as ModelUsageStats).provider : "",
        };
      }
    }
    this.modelUsage = restored;
  }

  /**
   * 获取真实总花费 = 主循环 + 辅助调用。
   * 用于 TUI 费用列展示、/cost 命令、quota/costLimit 守卫。
   */
  getEffectiveTotalCostUSD(): number {
    return this.totalCostUSD + this.sideCostUSD;
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
  calculateCost(model: string, usage: Usage, provider?: string, baseURL?: string): number {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);

    // 本地推理 provider（ollama 等）不产生真金白银费用，恒 0。
    // 否则其模型名不在定价表 → 走 FALLBACK_PRICING 被算出虚高费用，
    // 还会误触 costLimit 守卫中断本地会话（本地跑大上下文尤甚）。
    if (SessionState.isLocalProvider(prov)) {
      return 0;
    }

    const pricing = resolvePricing(model, this.availableModels, baseURL);
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
   *
   * P2-2（2026-08-08）：pricing 缺失时**不再返回 0**，改用与 {@link calculateCost}
   * 同源的 FALLBACK_PRICING 估算。旧行为造成一个必然出现的自相矛盾状态：
   * calculateCost 在 pricing=null 时用兜底价估出**非零成本**，而这里直接 return 0
   * ——于是账本里出现"成本非零、节省恒零"的行，看起来像"缓存完全没省钱"，
   * 实际只是两个函数对同一个未知模型给了不同答案。实测 349 会话里 81 个
   * savingsUSD=0，这是其中一条独立成因（另外三条：本地 provider、无命中时数学恒 0、
   * Math.max 钳位，都是正确行为，只有这条是缺陷）。
   */
  calculateSavings(model: string, usage: Usage, provider?: string, baseURL?: string): number {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);
    // 本地 provider 无费用 → 无"节省"概念，恒 0
    if (SessionState.isLocalProvider(prov)) return 0;
    const pricing = resolvePricing(model, this.availableModels, baseURL);
    const n = normalizeCacheUsage(usage, prov);
    // pricing 缺失时与 calculateCost 走同一套兜底价（该函数会记 WARN，此处不重复告警）
    const inputPrice = pricing?.input ?? SessionState.FALLBACK_PRICING.input;
    const outputPrice = pricing?.output ?? SessionState.FALLBACK_PRICING.output;
    // 全价成本：promptTotal 全按未命中输入 + 输出
    const hypothetical =
      (n.promptTotal / 1_000_000) * inputPrice +
      (n.outputTokens / 1_000_000) * outputPrice;
    const actual = this.calculateCost(model, usage, prov, baseURL);
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
    // 兜底启发式按**真名**判（与 inferPricingProvider 同口径）：别名带渠道前缀时
    // （gw-claude-sonnet-5）按别名判会落成 openai，缓存三段归一化口径反掉。
    const { resolveWireModel } = require("../llm/wire-model.ts");
    const wire: string = resolveWireModel(model, availableModels);
    return /^claude/i.test(wire) ? "anthropic" : "openai";
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
   * 获取末次输入 token（stock 口径，**provider 原始口径**，各模型 stats.inputTokens 之和）。
   *
   * ⚠️ 口径因 provider 而异（Anthropic=未命中余量 / OpenAI=含命中全量），**不适合直接展示当前上下文**。
   * 展示状态栏「输入 = 当前上下文大小」请用 {@link getStockPromptTokens}（已归一化为末次完整输入）。
   * 本方法保留供需要 provider 原始 inputTokens 的场景（调试/对比）使用。
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

  /**
   * 获取末次完整输入 token（stock 口径，**归一化 promptTotal**，各模型 stats.stockPromptTokens 之和）。
   *
   * 每次 API 调用覆盖写入 `normalizeCacheUsage(usage, provider).promptTotal`，即末次完整 prompt 大小：
   * - **Anthropic**：input_tokens（未命中余量）+ cache_read + cache_creation = 真实末次上下文。
   * - **OpenAI/DeepSeek**：prompt_tokens（本就含命中）= 完整上下文。
   *
   * 两家统一为「末次完整输入」，是**状态栏「输入」展示的正确口径**（反映当前上下文有多大）。
   * 修复了此前直接用 stats.inputTokens 在 Anthropic 下只显示 cache miss 增量、严重低估上下文的问题。
   *
   * 多模型会话场景：各模型 stock 值简单求和，实践中绝大多数会话只有单一模型。
   */
  getStockPromptTokens(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.stockPromptTokens;
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
