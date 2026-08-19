/**
 * defense-metrics.ts —— 三层防线的 metric 四件套（P1 · 防线状态可持续观测）
 *
 * ## 这个 PR 的收益是什么、不是什么
 *
 * ⚠️ **先把话说明白：加了这些 metric 之后，大概率仍然是全零。**
 * `bun scripts/defense-trigger-rate.ts` 实测 50 个会话、审计核查类 4 个、
 * 触发率 **0.0%**（41 个会话时也是 0.0%）。本模块的收益是
 * **「零触发这件事能被自动确认、成为可持续观测的时间序列」**，
 * **不是「发现新问题」** —— 把它写成后者就是夸大。
 *
 * 现状是：想知道防线触发了几次，得人工跑脚本翻 events.jsonl 考古。
 * 有了 counter 之后它是一条曲线，退化能被发现。
 *
 * ## 为什么不是「一个 counter 了事」
 *
 * 形状取自 codex 的 guardian 四件套（counter + duration + token histogram
 * **共用同一组 tag**）。关键在最后一件：
 * **「这道防线花了多少钱」比「它触发了几次」更能回答『它值不值得留』。**
 * 只有次数的话，一道每次触发都要烧掉 3 万 token 的防线，
 * 和一道纯内存判定的防线，在曲线上长得一模一样。
 *
 * ## 为什么埋在调用方而不是三个防线文件里
 *
 * 三层的**变量作用域几乎不相交**，这是实测出来的，不是设计选择：
 *
 * | 维度 | circuit-breaker | denial-tracking | policy-limits |
 * |---|---|---|---|
 * | 计数/阈值 | ✅ | ✅ | ❌ 无状态 |
 * | tool 名 | ❌ | ✅ | ❌ |
 * | 原因 | ❌ `recordFailure()` 零入参 | ✅ | ✅ |
 * | token | ❌（调用方有） | ❌ 权限层对 token 无感 | ❌ |
 *
 * 所以这里定义**共用信封**（layer / outcome / 可选 threshold+count），
 * 各层特有的维度作为可选项追加，埋点位置放在**标签真正存在的那一层**。
 * 硬凑一个"三层完全同构"的 tag set，只会得到三分之二是空的标签空间。
 */

import { getTelemetryBus } from "../index.ts";
import type { Attributes } from "../types.ts";

/** 防线层标识（闭集：新增防线时在这里登记，别用裸字符串） */
export type DefenseLayer =
  /** autoCompact 熔断器（`query/circuit-breaker.ts`） */
  | "compact_breaker"
  /** 权限连续拒绝熔断（`permission/denial-tracking.ts`） */
  | "denial_tracking"
  /** 企业策略功能开关（`config/policy-limits.ts`） */
  | "policy_limits";

/**
 * 防线动作结果。
 *
 * `tripped`（防线自身进入拦截态）与 `blocked`（某次具体请求被它挡下）必须分开：
 * 熔断器 open 一次可以挡掉后续 N 次调用，把两者混成一个数会让
 * 「触发了几次」这个问题没有确定答案。
 */
export type DefenseOutcome = "tripped" | "blocked" | "recovered";

/** metric 名（三层共用，靠 `sidcode.defense.layer` 标签切分） */
export const DEFENSE_TRIGGER_METRIC = "sidcode.defense.trigger";
export const DEFENSE_DURATION_METRIC = "sidcode.defense.duration_ms";
export const DEFENSE_TOKENS_METRIC = "sidcode.defense.tokens";

/** 「防线花了多少钱」的分桶边界（token 数，跨度大故按数量级铺） */
const DEFENSE_TOKEN_BOUNDS = [1000, 5000, 20000, 50000, 100000, 200000];

/** 判定耗时分桶（ms）。含 HITL 等待的路径可达数十秒，故尾部拉到 60s */
const DEFENSE_DURATION_BOUNDS = [1, 10, 50, 200, 1000, 5000, 30000, 60000];

/** 构造共用信封 —— 三层的 tag 必须同名同义，否则后端切不动 */
function envelope(layer: DefenseLayer, outcome: DefenseOutcome, extra?: DefenseTags): Attributes {
  const attrs: Attributes = {
    "sidcode.defense.layer": layer,
    "sidcode.defense.outcome": outcome,
  };
  // 以下全部**只在已知时才落**：落一个占位的 0 / "unknown" 会让
  // 「这层没有这个维度」和「这次取值恰好是 0」在后端长得一样。
  if (extra?.reason) attrs["sidcode.defense.reason"] = extra.reason;
  if (extra?.tool) attrs["sidcode.defense.tool"] = extra.tool;
  if (extra?.feature) attrs["sidcode.defense.feature"] = extra.feature;
  if (typeof extra?.count === "number") attrs["sidcode.defense.count"] = extra.count;
  if (typeof extra?.threshold === "number") attrs["sidcode.defense.threshold"] = extra.threshold;
  return attrs;
}

/** 各层可选追加的维度（都不是必填 —— 见文件头那张作用域表） */
export interface DefenseTags {
  /** 触发原因（denial-tracking / policy-limits 有，circuit-breaker 的 recordFailure 零入参故没有） */
  reason?: string;
  /** 被拦的工具名（仅 denial_tracking） */
  tool?: string;
  /** 被拦的功能名（仅 policy_limits） */
  feature?: string;
  /** 触发时的计数（如连续失败/连续拒绝次数） */
  count?: number;
  /** 触发阈值 —— 与 count 成对才有意义（单看 count=3 不知道是否到线） */
  threshold?: number;
}

/**
 * 记录一次防线动作。
 *
 * ⚠️ **同一次触发只调一次**。熔断器有两条进入 open 的路径
 * （half-open 探针失败 / 连续失败达阈值），两条都调就会把一次触发记成两次。
 */
export function recordDefenseTrigger(
  layer: DefenseLayer,
  outcome: DefenseOutcome,
  extra?: DefenseTags,
): void {
  try {
    getTelemetryBus().recordMetric({
      name: DEFENSE_TRIGGER_METRIC,
      value: 1,
      timestamp: Date.now(),
      attributes: envelope(layer, outcome, extra),
      type: "counter",
    });
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

/**
 * 记录防线**替代路径**的耗时（不是判定谓词的耗时）。
 *
 * ⚠️ **当前只有 `compact_breaker` 的熔断降级路径在调它**，这不是漏埋：
 *
 * - `policy_limits` 是同步布尔查表，纳秒级，测它没有意义。
 * - `denial_tracking` 的熔断落地为 `needsConfirmation` 后**当场返回**，
 *   「等用户确认」的墙钟不在它的作用域内。那个数（HITL 确认耗时，
 *   也就是「更安全 ↔ 更快」这个 trade-off 的计价器）要埋在 HITL 的应答回路上，
 *   **当前 trace 层无权限决策埋点，是已知缺口**。
 *
 * 在后两层硬凑一个"判定耗时"只会得到一列恒等于 0 的假数据 —— 那比没有更糟，
 * 因为它会让人以为这个维度已经被观测到了。
 */
export function recordDefenseDuration(
  layer: DefenseLayer,
  outcome: DefenseOutcome,
  durationMs: number,
  extra?: DefenseTags,
): void {
  try {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    getTelemetryBus().recordMetric({
      name: DEFENSE_DURATION_METRIC,
      value: durationMs,
      timestamp: Date.now(),
      attributes: envelope(layer, outcome, extra),
      type: "histogram",
      buckets: { bounds: [...DEFENSE_DURATION_BOUNDS] },
    });
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

/**
 * 记录被防线挡下/降级的那次调用消耗了多少 token（「这道防线花了多少钱」）。
 *
 * 目前只有 `compact_breaker` 拿得到真实 token（`ctxMgr.estimateTokens()`）；
 * 权限层与策略层对 token 无感，且没有便宜的取数路径。
 * **这不是漏埋，是那两层确实没有这个量** —— 硬凑会得到一列恒零的假数据。
 */
export function recordDefenseTokens(
  layer: DefenseLayer,
  outcome: DefenseOutcome,
  tokens: number,
  extra?: DefenseTags,
): void {
  try {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    getTelemetryBus().recordMetric({
      name: DEFENSE_TOKENS_METRIC,
      value: tokens,
      timestamp: Date.now(),
      attributes: envelope(layer, outcome, extra),
      type: "histogram",
      buckets: { bounds: [...DEFENSE_TOKEN_BOUNDS] },
    });
  } catch {
    /* 可观测性不影响正常流程 */
  }
}
