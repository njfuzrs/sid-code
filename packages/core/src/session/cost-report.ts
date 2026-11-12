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
  /** 高峰费用占比（0-1）。无分时段政策的模型为 1（全部按唯一价入账）。 */
  peakShare: number;
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

/** D14：缓存断裂摘要。 */
export interface CacheBreakSummary {
  count: number;
  /** 最近一条的人类可读归因（如「本地前缀 hash 没变，服务端缓存波动」）。渲染层附在次数后。 */
  latestReason: string | null;
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
  /** 本会话缓存断裂记录（`getRecentCacheBreaks()` 的结果，取条数 + 最新原因）。 */
  cacheBreaks: ReadonlyArray<{ changes: ReadonlyArray<string> }>;
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
    peakShare: stats.costUSD > 0 ? (stats.peakCostUSD ?? stats.costUSD) / stats.costUSD : 1,
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
        durationMs: 0,
        durationCalls: 0,
      };
      labelMap.set(d.label, row);
    }
    row.calls += 1;
    row.costUSD += d.costUSD;
    row.tokensSent += d.inputTokens;
    row.outputTokens += d.outputTokens;
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
  const cacheBreaks: CacheBreakSummary = {
    count: breaks.length,
    latestReason: breaks.length > 0 ? (breaks[breaks.length - 1]?.changes ?? []).join("；") : null,
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
