/**
 * /cost 的数据模型层（PR-B / D11–D15）—— 把「取数」从「渲染」里拆出来。
 *
 * 为什么需要这一层：改前 `cost.ts` 一边取数一边拼字符串，`/stats`（StatsDialog）、
 * `/debug` 各自再算一遍，同一个指标出现第二份算法（D9 的 4% 命中率就是这么来的）。
 * 拆成「core 纯函数产出 CostReport → cli 渲染成字符串」两层后：
 * - 无头模式 / 脚本可以直接消费 CostReport（不经过 ANSI）；
 * - 测试喂一个真实 SessionState 就能端到端对账（T-B3），不用伪造终端。
 *
 * 边界约定：本模块**不碰 IO**（不读 events.jsonl / 不查网关缓存文件）、**不带格式**
 * （不拼字符串、不做千分位）——那些分别归 SessionState 和 cli 渲染层。
 */

import type { ModelUsageStats, SessionState } from "./state.ts";
import type { ModelPricing } from "../api/cost-tracker.ts";
import { resolvePricing } from "../api/cost-tracker.ts";
import type { SideCallStats } from "../trace/side-call-sink.ts";
import { normalizeCacheUsage } from "../llm/types.ts";

/** 辅助调用按用途（label）聚合的一行。耗时/费用口径见 {@link CostReport.side}。 */
export interface SideLabelRow {
  label: string;
  calls: number;
  costUSD: number;
  tokensSent: number;
  outputTokens: number;
  /**
   * 这些调用里命中缓存的 input token（CP-10d）。
   *
   * 与 `tokensSent` 配对给出命中率：`tokensSent` 是 input 的累计，
   * `cacheReadTokens` 是其中按缓存价计费的部分，两者同源（同一次调用的 usage），
   * 所以「命中 90%」既可与主循环命中率对照，也能让用户看出这 325k 里九成不按原价算。
   */
  cacheReadTokens: number;
  /** 有采集到耗时的那些调用之和（`durationCalls < calls` 时只是下界，见 SideCallStats）。 */
  durationMs: number;
  /** 聚合进 durationMs 的调用数。小于 calls 时渲染层要写「其余未采集」。 */
  durationCalls: number;
}

/** 单个模型的取数行（/cost「按模型」段 + 单价来源）。 */
export interface CostModelRow {
  model: string;
  provider: string;
  requests: number;
  costUSD: number;
  /** 主循环四段费用（USD）。`carried === false` 时四段不可信（旧快照回灌），渲染层整段降级。 */
  breakdown: { uncachedUSD: number; hitUSD: number; writeUSD: number; outputUSD: number };
  carried: boolean;
  /** 入账时记录的价格来源（`"fallback"` 必须亮黄警告）。旧快照 undefined = 按无 fallback 处理。 */
  pricingSource?: string;
  /** 入账时走的端点（已剥 query）。undefined = 旧快照，按名查价（可能取到另一渠道的价，渲染时注明）。 */
  pricingBaseURL?: string;
  /** 按「模型 + 入账端点」解析到的原始价（**高峰价、未折算**）。null = 解析不到（理论上是 fallback）。 */
  pricing: ModelPricing | null;
  /**
   * 高峰**费用**占比（分子 = 高峰时段入账的费用，分母 = 本行总费用，范围 0-1）。
   *
   * ⚠️ **这个口径与账本的 `peakRatio` 不是同一个指标**：那个是「高峰**请求数** /
   * 分时段请求数」，分母是请求次数且范围覆盖全部 fetch（含辅助调用）；本字段分母是
   * 费用、范围只有主循环（modelUsage）。两者写进同一句话会让用户拿它们互相对照，
   * 所以渲染层必须写成「高峰费用占比」而不是笼统的「高峰占比」。
   *
   * **三态**（CP-3）：
   * - `undefined` 且 `costUSD > 0` → 时段拆分不可用（旧快照回灌后两桶都是 0，
   *   或者两桶之和与总额不符）。渲染层写「时段拆分不可用」，**不猜一个值**；
   * - `0` → 全程空闲时段（`peakCostUSD` 从未写过，这就是「全程空闲」的直接证据）；
   * - `1` → 全程高峰时段。
   *
   * 改动前的写法是 `(peakCostUSD ?? costUSD) / costUSD`，`undefined` 回落成总额
   * 于是恒为 1 —— 越是在空闲时段干活，面板越说你在付高峰价。无数据时返回 `undefined`
   * 而不是 1，就是修掉这个方向固定的错误。
   */
  peakShare: number | undefined;
  /** token 三段（flow 口径，与 ModelUsageStats 累加值一致）。 */
  uncachedTokens: number;
  cacheHitTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** 推理 token（output 的子集，openai 族才有）。旧快照 undefined → 0。 */
  reasoningTokens: number;
}

/** D13：单次请求费用分布（本进程环形缓冲，resume 后只有本进程的部分）。 */
export interface PerRequestStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** 最贵 3 次（按费用降序）。`index` 是缓冲内的次序（1 起）。 */
  top: Array<{ index: number; costUSD: number; promptTokens: number; cacheHit: number }>;
}

/**
 * CP-8：最近一条「命中下降」的**结构化证据**。
 *
 * 为什么要这组字段，而不是继续用 `changes[]` 里的中文句子：`/cost` 旧的归因文案
 * 只露出了最弱的一条证据（system/tools 的 hash 未变，但不含消息），而更强的两条
 * （消息前缀逐字节一致、两次请求间无重试）判过了却没有显示 —— 渲染层拿不到它们，
 * 只能对 `changes` 做字符串拼接。字段在这里结构化，渲染层**按字段拼文案**。
 *
 * 三个证据字段都是三态：`true` 成立 / `false` 不成立 / `undefined` 不可判（不猜）。
 */
export interface CacheBreakEvidence {
  dropPercent: number;
  dropTokens: number;
  previousCacheReadTokens: number;
  currentCacheReadTokens: number;
  /** 结构化归因类别（与 changes 同处产出）。 */
  categories: ReadonlyArray<string>;
  /** system + tools 的前缀 hash 是否与上一次相同。 */
  prefixHashSame?: boolean;
  /** 消息前缀是否逐字节一致（尾部追加不算变化）。 */
  messagePrefixSame?: boolean;
  /** 这次响应前是否发生过 loop 级重试。 */
  precededByRetry?: boolean;
}

/**
 * CP-9：字节侧（`trace/prefix-break-probe.ts`）的本地前缀断裂摘要。
 *
 * 这是**第二个检测器**，与上面的 token 侧 `CacheBreakSummary` 各报各的：
 * token 侧的判据是「命中 token 大幅下降」，它天然看不见「命中还在低位爬升、
 * 但前缀已经被改写」这一类（断裂发生在预热期时命中反而是上升的）。
 * 字节侧逐字符比对，能看到，但此前只落 events.jsonl，`/cost` 完全不显示。
 */
export interface PrefixBreakSummary {
  /**
   * 该检测器本次是否可用（调用方传了 `prefixBreaks`）。
   *
   * false 时渲染层**整行省略**，不能写「0 次」——「没采集到」与「采集到且没断裂」
   * 是两件事，写成同一个 0 会让用户以为前缀一直是健康的。
   */
  available: boolean;
  /** 本会话断裂次数（`broken === true` 的轮次；未断裂的轮次不计）。 */
  count: number;
  /** 最近一次断裂浪费的字符比例（0-1，分母是上一轮前缀长度）。undefined = 无断裂。 */
  latestWastedRatio: number | undefined;
}

/**
 * 归到「上游」的类别：本地看不到、也改不动的一侧。
 *
 * `server_fluctuation` 的定义是「system / tools / 消息前缀都没变（或不可判）」而命中下降，
 * 成因在网关路由或厂商缓存节点上。走不可信渠道时它更可能是渠道噪声，但同样不是本地能改的，
 * 所以照样归上游 —— 分不清「上游哪一段」与「是不是上游」是两件事。
 */
const UPSTREAM_CATEGORY = "server_fluctuation";

/**
 * 归到「本地可优化」的类别：这些都能通过改本地行为消掉。
 *
 * 刻意**不含** `model` 与 `ttl_expiry`：换模型必然全量重算、空闲超过 TTL 也必然掉缓存，
 * 两者都是正常行为而不是可优化的缺陷。把它们算进「本地」会让本地问题看起来比实际多，
 * 用户照着优化也优化不掉。
 */
const LOCAL_CATEGORIES: ReadonlySet<string> = new Set([
  "system_prompt",
  "tools",
  "tool_order",
  "cache_policy",
  "beta_headers",
  "compact",
  "prefix_break",
  "message_history",
]);

/** 一条断裂记录是否含「本地可优化」的归因。只读 `categories`，不碰 `changes` 文案。 */
function isLocalCategory(categories?: ReadonlyArray<string>): boolean {
  return (categories ?? []).some((c) => LOCAL_CATEGORIES.has(c));
}

/** D14：缓存断裂摘要。 */
export interface CacheBreakSummary {
  count: number;
  /** 最近一条的人类可读归因（如「本地前缀 hash 没变，服务端缓存波动」）。渲染层附在次数后。 */
  latestReason: string | null;
  /**
   * 归因计数（**按 `categories` 结构化统计，不解析 changes 字符串**）：
   * - `upstreamCount`：命中下降归到上游（网关/厂商缓存波动、渠道噪声）；
   * - `localCount`：归到本地可优化（前缀/历史被改写、工具顺序变化等）。
   *
   * 两类之外还有「模型变化 / TTL 过期 / 不可判」，它们既不是本地问题也不是上游波动，
   * 所以 `upstream + local` 可以小于 `count` —— 渲染层照实显示差额，不要凑成相等。
   */
  upstreamCount: number;
  localCount: number;
  /** 最近一条的结构化证据。null = 没有断裂记录。 */
  latest: CacheBreakEvidence | null;
  /** 字节侧断裂（另一个检测器，见 {@link PrefixBreakSummary}）。 */
  prefixBreaks: PrefixBreakSummary;
}

/** D2：后台闸门状态（/cost 提示「数字还会变」的判据）。 */
export interface PendingTasksView {
  busy: boolean;
  busyLabel: string | null;
  pendingLabels: string[];
}

/** buildCostReport 的外部输入（进程级单例 / 依赖注入，纯函数本体不 import 它们）。 */
export interface BuildCostReportOptions {
  /** 辅助调用统计（进程维度快照，`getSideStats()` 的结果）。费用对账走 SessionState.sideCostUSD。 */
  sideStats: SideCallStats;
  /** 后台闸门状态（进程级单例快照）。 */
  gateStats: PendingTasksView;
  /**
   * 本会话缓存断裂记录（`getRecentCacheBreaks()` 的结果）。
   *
   * 只需结构兼容即可：传入 `CacheBreakRecord[]` 时字段全部可用；测试可以只给
   * `changes`（旧夹具）。**归因统计只读 `categories`**，不做 `changes` 子串匹配 ——
   * 那是 P0-2 明确修掉的反模式（文案改一个字所有历史统计就断）。
   */
  cacheBreaks: ReadonlyArray<{
    changes: ReadonlyArray<string>;
    categories?: ReadonlyArray<string>;
    dropPercent?: number;
    dropTokens?: number;
    previousCacheReadTokens?: number;
    currentCacheReadTokens?: number;
    prefixHashSame?: boolean;
    messagePrefixSame?: boolean;
    precededByRetry?: boolean;
  }>;
  /**
   * 字节侧断裂记录（`getRecentPrefixBreaks()` 的结果，CP-9）。
   *
   * 与上面的 `cacheBreaks` 是**两个独立检测器**：一个看命中 token，一个逐字符比对前缀。
   * 缺省 = 没有该检测器的数据（渲染层整行省略，不写「0 次」冒充「没有断裂」）。
   *
   * 数组里**每一条都是一次真实断裂**（`recordPrefixBreak` 只在 `broken === true` 时调用），
   * 所以条数即次数 —— 不要再按 `broken` 过滤一遍，那会让「有记录」与「记录有效」变成两份判据。
   */
  prefixBreaks?: ReadonlyArray<{ charWastedRatio?: number }>;
  /**
   * 辅助调用自报对账差额（PR-A 的 `reconcileSelfReports()` 结果，CP-1 的收尾）。
   *
   * `/cost` 在辅助调用还在途时打开，自报可能晚几毫秒才入账 —— 这个差额**只提示不补账**
   * （补账由会话结束时的 `reconcileSelfReports({ apply: true })` 做）。用户看到提示就知道
   * 「数字还会涨」，而不是怀疑面板算漏了。
   */
  selfReportGap?: { pendingCalls: number };
  /** 生效的花费上限（USD）。0 / 缺省 = 未设置，不显示预算段。 */
  costLimitUSD?: number;
  /** 计价时刻（默认 now）。测试传固定时刻让单价来源稳定。 */
  now?: Date;
}

/** /cost 面板的完整数据模型。渲染层只做 `CostReport → string`，不再取数。 */
export interface CostReport {
  totals: {
    /** 真实总花费 = 主循环（含子代理）+ 辅助调用。 */
    costUSD: number;
    mainCostUSD: number;
    sideCostUSD: number;
    fxConverted: boolean;
    /** 实际换算过的币种（按币种去重），供「1 USD = 7.1 CNY」说明。 */
    conversions: Array<{ currency: string; perUSD: number }>;
  };
  durations: {
    /** 会话墙钟（含思考/空闲）。 */
    wallMs: number;
    /** 主循环 API 耗时（不含子代理与辅助调用）。 */
    apiMainMs: number;
    /** 工具执行耗时。 */
    toolMs: number;
    /** 辅助调用耗时（**进程维度**：resume 基线没有逐条耗时，只是本次启动后的下界）。 */
    sideApiMs: number;
    /** sideApiMs 覆盖到的调用数（< side.calls 时渲染层写「其余未采集」）。 */
    sideDurationCalls: number;
  };
  /** 范围：主循环 + 子代理（modelUsage）。 */
  main: {
    requests: number;
    discardedRequests: number;
    discardedPromptTokens: number;
    /** flow 口径三段（互斥，promptTotal = 三者之和）。 */
    uncachedTokens: number;
    cacheHitTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    /** 累计发送（= uncached + hit + write，flow）。 */
    promptTotal: number;
    /** stock：最后一次请求的完整 prompt（状态栏 ↑）。 */
    contextNow: number;
    cacheHitRate: number | undefined;
    savingsUSD: number;
    /**
     * 四段费用（USD）—— **`byModel` 各段之和**，与上面的三段 token 一一配对。
     *
     * CP-4：渲染层的费用列此前只取 `byModel.length === 1` 的那一行，多模型时四段全显示
     * `$0.0000`，于是「token × 单价 = 费用」既算不出也验不了。聚合到 main 之后，
     * 单模型与多模型走同一份数据，逐段验算恒成立。
     */
    breakdown: { uncachedUSD: number; hitUSD: number; writeUSD: number; outputUSD: number };
    /**
     * 四段费用是否可信（等价于**所有**模型行 `carried === true`）。
     *
     * false = 存在旧快照回灌的模型行（四段为 0 而 costUSD > 0）。渲染层据此把费用列
     * 降级为「不可用」而不是拿 0 冒充——0 与「不知道」混在一起，用户会以为这几段免费。
     */
    breakdownCarried: boolean;
    /**
     * 四段**实际均价**（USD/百万）= `该段费用 ÷ 该段 token × 1e6`。
     *
     * 为什么不是牌价：一个会话可能横跨高峰与空闲，`pricing` 里只有高峰那一档，
     * 拿它乘 token 会与费用列差一倍（CP-4 的实测：未命中 $0.0244 vs 显示 $0.0122）。
     * 均价是**由费用反推**的，所以「token × 均价 = 费用」按构造恒成立 ——
     * 全高峰、全空闲、混合、人民币计价、多模型聚合五种情况都不需要特判。
     *
     * `undefined` = 该段 token 为 0（没有可算的均价，渲染层写 `—`，不要写 0）。
     * 注意它**看不出牌价**，所以牌价必须同时出现在来源行，否则用户失去「价目是多少」这个信息。
     */
    avgPrice: { uncached?: number; hit?: number; write?: number; output?: number };
  };
  byModel: CostModelRow[];
  side: {
    calls: number;
    failed: number;
    tokensSent: number;
    outputTokens: number;
    /** 本进程采集到耗时的调用数（`durationCalls < calls` 时 sideDurationMs 只是下界）。 */
    durationCalls: number;
    /** 辅助调用耗时（进程维度，见 durations.sideApiMs）。 */
    durationMs: number;
    /** 按用途（label）拆分。**进程维度**：resume 基线只有汇总没有逐条，拆分只含本次启动后。 */
    byLabel: SideLabelRow[];
  };
  perRequest: PerRequestStats | null;
  /** 用了兜底价的模型名（黄警告，必须写明「估的」）。空数组 = 无。 */
  fallbackModels: string[];
  /**
   * 辅助调用自报尚未入账的笔数（PR-A 的对账差额）。0 或缺省 = 无提示。
   *
   * 原样透传调用方（`cost.ts` 调 `reconcileSelfReports()`）的结果，本层不补账：
   * 在途调用的自报可能晚到几毫秒，这里补账会重复入账。
   */
  selfReportGap?: { pendingCalls: number };
  cacheBreaks: CacheBreakSummary;
  budget?: { limitUSD: number; ratio: number };
  pending: PendingTasksView;
}

/** p 分位（线性插值不用——展示口径用「第 ceil(p·n) 个」就够，避免渲染层再解释插值）。 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/** 从 ModelUsageStats 派生单价行（含「旧快照无拆分」的降级标记）。 */
/**
 * CP-3：把「高峰费用占比」算成**三态**而不是一个总是有值的数。
 *
 * 旧写法 `(peakCostUSD ?? costUSD) / costUSD` 的 `??` 是 bug 的来源：全程空闲的会话
 * 从不写 `peakCostUSD`（`state.ts` 的 updateUsage 只往 offpeak 桶累加），于是
 * `undefined` 回落成总额，占比恒为 1 —— 面板因此说「全程高峰时段」。
 *
 * 三个不可用的出口都返回 `undefined`（渲染层据此写「时段拆分不可用」）：
 * - 没有费用：不存在占比这回事；
 * - 两桶都缺失：D11 之前落盘的旧快照，或这段统计没走过分桶分支；
 * - 两桶之和 ≠ 总额：拆分与总额对不上（旧快照回灌后两桶被 `|| 0` 抹成 0 就是这种），
 *   此时**不能猜**——猜哪个方向都会给用户一个假的时段结论。
 */
function resolvePeakShare(stats: ModelUsageStats): number | undefined {
  if (!(stats.costUSD > 0)) return undefined;
  if (stats.peakCostUSD === undefined && stats.offpeakCostUSD === undefined) return undefined;
  const peak = stats.peakCostUSD ?? 0;
  const offpeak = stats.offpeakCostUSD ?? 0;
  // 1e-9 与 D11/D12 的「四段之和 === costUSD」判据同一量级：浮点累加误差远小于它，
  // 而真正的口径错配（差值 = 整个总额）远大于它。
  if (Math.abs(peak + offpeak - stats.costUSD) > 1e-9) return undefined;
  return peak / stats.costUSD;
}

function buildModelRow(
  model: string,
  stats: ModelUsageStats,
  ss: SessionState,
  now: Date,
): CostModelRow {
  // 字段名跟 ModelUsageStats 的落盘名（uncachedInputUSD/cacheHitUSD/cacheWriteUSD），
  // 不在这里换名：D12 的「四段之和 === costUSD」要能一眼对上，中间改一次名字就多一处漂移点。
  const breakdown = {
    uncachedUSD: stats.uncachedInputUSD ?? 0,
    hitUSD: stats.cacheHitUSD ?? 0,
    writeUSD: stats.cacheWriteUSD ?? 0,
    outputUSD: stats.outputUSD ?? 0,
  };
  const breakdownSum =
    breakdown.uncachedUSD + breakdown.hitUSD + breakdown.writeUSD + breakdown.outputUSD;
  // carried：四段之和 === costUSD（同源入账时恒成立；旧快照回灌四段为 0 而 costUSD > 0）。
  // false 时渲染层把「按价格项拆费用」降级为「不可用（历史数据无拆分）」，不要拿 0 冒充拆分。
  const carried = stats.costUSD === 0 || Math.abs(breakdownSum - stats.costUSD) < 1e-9;
  return {
    model,
    provider: stats.provider,
    requests: stats.requests,
    costUSD: stats.costUSD,
    breakdown,
    carried,
    pricingSource: stats.pricingSource,
    pricingBaseURL: stats.pricingBaseURL,
    // 单价按「模型 + 入账端点」取（D11）：与计费同一条价。入账端点缺失（旧快照）按名查，
    // 拿到的可能不是计费用的那条 —— 显示来源时用「当前解析」的措辞，不冒充入账价。
    pricing: resolvePricing(model, ss.getAvailableModels(), stats.pricingBaseURL),
    // CP-3：三态，不要回落成总额（回落 = 恒 1 = 全程空闲被显示成全程高峰）
    peakShare: resolvePeakShare(stats),
    uncachedTokens: 0,
    cacheHitTokens: stats.cacheReadInputTokens,
    cacheWriteTokens: stats.cacheCreationInputTokens,
    outputTokens: stats.outputTokens,
    reasoningTokens: stats.reasoningTokens ?? 0,
    ...(now ? {} : {}),
  };
}

/**
 * 构造 /cost 数据模型。纯函数：所有进程级单例（side-call-sink / 后台闸门 / 缓存断裂
 * 检测器）经 opts 注入快照，测试传假数据即可覆盖全部分支，不需要占用真实单例。
 */
export function buildCostReport(ss: SessionState, opts: BuildCostReportOptions): CostReport {
  const now = opts.now ?? new Date();
  const usage = ss.getTotalUsage();
  const cacheView = ss.getNormalizedCacheUsage();
  const side = opts.sideStats;

  // 主循环三段 token（flow）：三段互斥、promptTotal = 三段之和（normalizeCacheUsage 的恒等式）。
  const uncachedTokens = cacheView.uncachedInputTokens;
  const promptTotal = cacheView.promptTotal;

  // byModel 行 + 每行的 uncachedTokens（openai 族 uncached = promptTotal − hit − write，
  // anthropic 族 uncached = 累计未命中；两家都从 ModelUsageStats 归一化而来）。
  const byModel: CostModelRow[] = Object.entries(ss.modelUsage).map(([model, stats]) => {
    const row = buildModelRow(model, stats, ss, now);
    const n = uncachedOf(stats);
    return { ...row, uncachedTokens: n };
  });

  // CP-4：主循环四段费用聚合 = byModel 各段之和。
  // 与上面三段 token 配对的是**同一个范围**（主循环 + 子代理，modelUsage），
  // 所以「该段 token × 均价 ÷ 1e6 === 该段费用」在单模型与多模型下都成立。
  const mainBreakdown = byModel.reduce(
    (acc, row) => ({
      uncachedUSD: acc.uncachedUSD + row.breakdown.uncachedUSD,
      hitUSD: acc.hitUSD + row.breakdown.hitUSD,
      writeUSD: acc.writeUSD + row.breakdown.writeUSD,
      outputUSD: acc.outputUSD + row.breakdown.outputUSD,
    }),
    { uncachedUSD: 0, hitUSD: 0, writeUSD: 0, outputUSD: 0 },
  );
  // 一行不可信就不能声称「四段可信」：部分模型是旧快照时，四段之和会小于 mainCostUSD，
  // 拿它算占比会让「其余」凭空消失。渲染层按整段降级处理。
  const mainBreakdownCarried = byModel.every((row) => row.carried);

  // 辅助调用按用途拆分（进程维度 details 聚合；byLabel 里只有 success/failed 没有费用）。
  const labelMap = new Map<string, SideLabelRow>();
  for (const d of side.details) {
    let row = labelMap.get(d.label);
    if (!row) {
      row = {
        label: d.label,
        calls: 0,
        costUSD: 0,
        tokensSent: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        durationMs: 0,
        durationCalls: 0,
      };
      labelMap.set(d.label, row);
    }
    row.calls += 1;
    row.costUSD += d.costUSD;
    row.tokensSent += d.inputTokens;
    row.outputTokens += d.outputTokens;
    row.cacheReadTokens += d.cacheReadTokens;
    if (d.durationMs !== undefined) {
      row.durationMs += d.durationMs;
      row.durationCalls += 1;
    }
  }
  const byLabel = [...labelMap.values()].sort((a, b) => b.costUSD - a.costUSD);

  // D13：单次请求分布（环形缓冲，本进程）。无入账时不显示该段。
  const log = ss.getRequestLog();
  let perRequest: PerRequestStats | null = null;
  if (log.length > 0) {
    const costs = log.map((e) => e.costUSD).sort((a, b) => a - b);
    // 「第 N 次」= 缓冲内的请求次序（1 起），不是费用排名 —— 用户拿它去对
    // 「会话开头缓存没热起来最贵」这类时序结论，排名 1/2/3 会误导成前 3 次。
    // /clear 后缓冲清空、resume 只含本进程，次序与这两条口径天然一致。
    const top = log
      .map((e, i) => ({ e, ordinal: i + 1 }))
      .sort((a, b) => b.e.costUSD - a.e.costUSD)
      .slice(0, 3)
      .map(({ e, ordinal }) => ({
        index: ordinal,
        costUSD: e.costUSD,
        promptTokens: e.promptTokens,
        cacheHit: e.cacheHit,
      }));
    perRequest = {
      count: log.length,
      p50: percentile(costs, 50),
      p95: percentile(costs, 95),
      max: costs[costs.length - 1] ?? 0,
      top,
    };
  }

  // 兜底价模型（黄警告）：入账记录的 pricingSource，不看当前解析（当前能解析不代表当时不是兜底）。
  const fallbackModels = Object.entries(ss.modelUsage)
    .filter(([, s]) => s.pricingSource === "fallback")
    .map(([m]) => m);

  const breaks = opts.cacheBreaks;
  const lastBreak = breaks[breaks.length - 1];
  const cacheBreaks: CacheBreakSummary = {
    count: breaks.length,
    latestReason: lastBreak ? lastBreak.changes.join("；") : null,
    // CP-8：归因统计**只读 categories**。文案匹配是 P0-2 修掉的反模式 ——
    // 一条 changes 改个措辞，历史统计就整体漂移，而且没有任何东西会红。
    upstreamCount: breaks.filter((b) => (b.categories ?? []).includes(UPSTREAM_CATEGORY)).length,
    localCount: breaks.filter((b) => isLocalCategory(b.categories)).length,
    latest: lastBreak
      ? {
          dropPercent: lastBreak.dropPercent ?? 0,
          dropTokens: lastBreak.dropTokens ?? 0,
          previousCacheReadTokens: lastBreak.previousCacheReadTokens ?? 0,
          currentCacheReadTokens: lastBreak.currentCacheReadTokens ?? 0,
          categories: lastBreak.categories ?? [],
          // 三个证据字段原样透传：undefined 保持 undefined（「不可判」不是「没变」）
          ...(lastBreak.prefixHashSame !== undefined
            ? { prefixHashSame: lastBreak.prefixHashSame }
            : {}),
          ...(lastBreak.messagePrefixSame !== undefined
            ? { messagePrefixSame: lastBreak.messagePrefixSame }
            : {}),
          ...(lastBreak.precededByRetry !== undefined
            ? { precededByRetry: lastBreak.precededByRetry }
            : {}),
        }
      : null,
    // CP-9：字节侧断裂（第二个检测器）。未传 = 该检测器不可用，渲染层整行省略 ——
    // 写「0 次」会与「没采集到」混成同一个值，正是本缺陷要消灭的那类混淆。
    prefixBreaks: {
      available: opts.prefixBreaks !== undefined,
      // 每一条都是一次真实断裂（见 BuildCostReportOptions.prefixBreaks 的类型注释），
      // 所以条数即次数，不再按 broken 过滤第二遍。
      count: (opts.prefixBreaks ?? []).length,
      latestWastedRatio: (opts.prefixBreaks ?? [])[(opts.prefixBreaks ?? []).length - 1]
        ?.charWastedRatio,
    },
  };

  const budget =
    opts.costLimitUSD && opts.costLimitUSD > 0
      ? {
          limitUSD: opts.costLimitUSD,
          ratio: ss.getEffectiveTotalCostUSD() / opts.costLimitUSD,
        }
      : undefined;

  return {
    totals: {
      costUSD: ss.getEffectiveTotalCostUSD(),
      mainCostUSD: ss.totalCostUSD,
      sideCostUSD: ss.sideCostUSD,
      fxConverted: ss.isCostFxConverted(),
      conversions: ss.getCurrencyConversions(),
    },
    durations: {
      wallMs: ss.getElapsedMs(),
      apiMainMs: ss.totalAPIDuration,
      toolMs: ss.totalToolDuration,
      sideApiMs: side.durationMs,
      sideDurationCalls: side.durationCalls,
    },
    main: {
      requests: ss.getTotalRequests(),
      discardedRequests: ss.getDiscardedRequests(),
      discardedPromptTokens: sumDiscardedTokens(ss),
      uncachedTokens,
      cacheHitTokens: cacheView.cacheHitTokens,
      cacheWriteTokens: cacheView.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: sumReasoning(ss),
      promptTotal,
      contextNow: ss.getStockPromptTokens(),
      // 不复用 `ss.getCacheHitRate()`：那个接口刻意返回 0-100 的**整数**（Footer/状态栏的契约，
      // `cache-usage.test.ts` 锁着 78 这样的整数值）。面板版式要 1 位小数（D15 的 91.7%），
      // 用整数会把它显示成 92%，与「命中率偏低」提示的阈值判断也不同源。
      // 这里用同一份 cacheView 精确算一次，判据仍然是「命中 / 三段之和」。
      cacheHitRate:
        cacheView.cacheHitTokens > 0 && promptTotal > 0
          ? (cacheView.cacheHitTokens / promptTotal) * 100
          : undefined,
      savingsUSD: ss.getTotalCacheSavings(),
      breakdown: mainBreakdown,
      breakdownCarried: mainBreakdownCarried,
      // CP-4：均价由**费用反推**（不是牌价），所以「token × 均价 ÷ 1e6 = 费用」按构造成立。
      // 四段各算一次，token 为 0 的段返回 undefined（渲染层写 —，不要写 0）。
      avgPrice: {
        uncached: avgUnitPrice(mainBreakdown.uncachedUSD, uncachedTokens),
        hit: avgUnitPrice(mainBreakdown.hitUSD, cacheView.cacheHitTokens),
        write: avgUnitPrice(mainBreakdown.writeUSD, cacheView.cacheWriteTokens),
        output: avgUnitPrice(mainBreakdown.outputUSD, usage.outputTokens),
      },
    },
    byModel,
    side: {
      calls: side.apiCalls,
      failed: side.failed,
      tokensSent: side.tokensSent,
      outputTokens: side.tokensReceived,
      durationCalls: side.durationCalls,
      durationMs: side.durationMs,
      byLabel,
    },
    perRequest,
    fallbackModels,
    cacheBreaks,
    budget,
    pending: opts.gateStats,
    // PR-A 的收尾：对账差额原样透传（本层不补账，见字段 JSDoc）
    ...(opts.selfReportGap ? { selfReportGap: opts.selfReportGap } : {}),
  };
}

/** 各模型作废 prompt 之和（D14「重试白烧」行，有值才显示）。 */
function sumDiscardedTokens(ss: SessionState): number {
  let total = 0;
  for (const s of Object.values(ss.modelUsage)) total += s.discardedPromptTokens ?? 0;
  return total;
}

/** 各模型推理 token 之和（「其中推理」，openai 族是 output 的子集）。 */
function sumReasoning(ss: SessionState): number {
  let total = 0;
  for (const s of Object.values(ss.modelUsage)) total += s.reasoningTokens ?? 0;
  return total;
}

/**
 * CP-4：四段实际均价（USD/百万）= 该段费用 ÷ 该段 token × 1e6。
 *
 * 单位取「百万 token」与牌价同台，用户拿它乘 token 就能验算费用列 —— 这正是单价列
 * 存在的唯一意义。`token === 0` 返回 `undefined`（渲染层写 `—`），不返回 0：
 * 「这一段没有 token」与「均价是 0」是两件事，后者会把免费额度混进付费均价。
 */
function avgUnitPrice(usd: number, tokens: number): number | undefined {
  return tokens > 0 ? (usd / tokens) * 1e6 : undefined;
}

/**
 * 单模型 uncached（flow）—— 与 `getNormalizedCacheUsage` **同源**派生。
 *
 * 之前这里手写过「openai 族做减法 / anthropic 直取」的第二份实现，变异自证（MUTATION-2）
 * 发现把它改坏后测试全绿：`main.uncachedTokens` 走 `getNormalizedCacheUsage`，
 * `byModel[].uncachedTokens` 走这里，两处口径可以各自漂移而互不报警——正是 D9
 * 「同一个指标第二份算法」的形态。收口到 normalizeCacheUsage 后只有一个实现，
 * `Σ byModel.uncached === main.uncached` 由同一函数保证。
 */
function uncachedOf(stats: ModelUsageStats): number {
  return normalizeCacheUsage(
    {
      // flow 口径：与 getNormalizedCacheUsage 的逐模型构造一致（cumulativePromptTokens，
      // 不是 stock 末次 inputTokens——末次值配累加命中会钳 0，见 state.ts 的注释）。
      inputTokens: stats.cumulativePromptTokens,
      outputTokens: stats.outputTokens,
      cacheReadInputTokens: stats.cacheReadInputTokens,
      cacheCreationInputTokens: stats.cacheCreationInputTokens,
    },
    stats.provider,
  ).uncachedInputTokens;
}
