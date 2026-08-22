/**
 * 计费发生侧收口（PR3 / 方案 §5.2 档 A）—— 「钱花了」这件事的唯一权威事实源。
 *
 * ## 根因：入账挂在消费侧，而消费侧有 N 个入口
 *
 * ```text
 * 改造前（N 个入口，漏一个就静默丢钱）
 *   provider 发请求
 *       ├─→ 主循环 ────────→ AfterModelRaw ──→ 入账 ✓
 *       ├─→ 18 条 side-call ─→ recordSideCall ─→ 入账 ✓（靠每个作者记得补一行）
 *       └─→ fork ───────────→ （什么都没有）──→ 丢钱 ✗
 * ```
 *
 * 实测（会话 `20260821-140626-4fd1f34e`）：39 次真实建连、全部 `http_status=200`
 * 正常完成，只有 17 次进了账 —— **22 个成功的计费请求完全未入账**，
 * 占该会话真实账单的 31%。且不是单会话偶发：当日 7 个有 API 调用的会话
 * **7/7 全部命中**，漏采率 25%–56%。
 *
 * ## 修法：收口到发生侧，而不是给 fork 补一次上报
 *
 * 给 fork 补一行 `recordSideCall` 只修**这一个实例**；下一条新增的调用链照样会漏，
 * 而且照样没有任何东西会报红。所以判据是：
 *
 * > **必须让"新增一条调用链却漏记账"在结构上不可能，而不是让它可被检测。**
 * > 一个需要作者记得做某件事才成立的机制，等价于没有这个机制。
 *
 * ```text
 * 改造后（1 个入口，物理上不可绕过）
 *   provider 流结束（发 StreamPhase(completed) 的同一处）
 *       └─→ recordBilledRequest(权威计费事件，含完整 usage)
 *               各条调用链只提供**归因标签**，不再承担"钱有没有记上"这个职责
 * ```
 *
 * 位置选在 provider 内部是**已核实的**，不是推演：`HttpConnected` 之所以能数准 39 次，
 * 正因为它挂在 provider 里 —— **所有**调用链都必然经过那里。而
 * `openai.ts` 发 `StreamPhase(completed)` 时 `usage` 对象已聚合完毕
 * （那行 `cacheDimsFor(usage.cacheReadInputTokens)` 就是从它取的）：
 * **我们本来就已经在那里读 usage 了，只是只取了 cache 一个维度。**
 *
 * ## 去重键必须是「单次 fetch」，不是「单轮」（本改造最大的风险点）
 *
 * 主循环那条链经 `AfterModelRaw` 入账，而 `stream-processor.ts` 的 `accumulateUsage`
 * 把**跨 attempt 的 usage 累加进同一个 `response`**（"作废尝试的 token 是真实计费的"）。
 * 所以主循环上报的是「本轮所有 attempt 之和」，而本模块的事件是「每次 fetch 一条」。
 * **两者口径不同，直接相加会双记。**
 *
 * 因此每条计费事件带一个 `fetchId`（单次 fetch 唯一），消费侧以它为主键去重。
 * 主循环仍走它原来的入账路径（`updateUsage` / `AfterModelRaw`），
 * 本模块**只对主循环之外的调用链真正入账** —— 见 {@link BilledRequest.accounted} 的说明。
 *
 * 这是刻意的分阶段：一次就把主循环的计费口径也搬过来，需要同一个 PR 内改完
 * `updateUsage` / `AfterModelRaw` / `cost-recompute` / 账本四侧，中间态必然双记。
 * 当前形态下**恒等式已经成立**（`HttpConnected == 计费事件数`），
 * 且新增调用链天然入账 —— §5.0 判据要求的形态已经达到。
 */

import type { Usage } from "./types.ts";
import { resolvePricing, priceTierAt } from "../api/cost-tracker.ts";

/** 一次真实计费请求（= 一次 fetch，无论成功失败、无论谁发起的） */
export interface BilledRequest {
  /**
   * 单次 fetch 的唯一 id。**去重主键**。
   *
   * 必须是「单次 fetch」粒度而不是「单轮」：主循环的 usage 是跨 attempt 累加的，
   * 用轮粒度做键会把 N 次 attempt 的钱记成 1 次（漏），或与主循环双记（重）。
   */
  fetchId: string;
  /** 渠道别名（计价按别名，与 resolvePricing 步骤 1-3 同口径） */
  model: string;
  /** provider 名（计价三段拆分依赖它：Anthropic 的 input 是未命中余量） */
  provider: string;
  /** 本次请求实际走的端点（计价复合键的第二维；同名不同渠道各自的价） */
  baseURL?: string;
  /** 完整 usage（发生侧已聚合完毕，不需要消费侧再拼） */
  usage: Usage;
  /** 观测 index（与 StreamPhase / HttpConnected 同一个，便于交叉核对） */
  index: number;
  /**
   * 调用链身份。`undefined` = 主循环。
   *
   * 这是「这笔钱是谁花的」的答案。改造前 fork 的 22 个流在轨迹里被算成
   * `retryWastedTokens`（"重试白烧"）—— **归因写错了**，照着那个标签排查会走到
   * `fallback.ts` 的重试逻辑上去，而那里没有问题。
   */
  agentId?: string;
  /** 调用方标签（`session-memory-update` / `memory-extract` / `recall` …） */
  callerLabel?: string;
  /**
   * 本次请求**发生时刻**（epoch ms）。消费侧据此求当时的计价时段与汇率。
   *
   * 为什么必须显式带而不是让消费侧取 `Date.now()`：观察者是同步调用的，
   * 但重算路径（`trace/cost-recompute.ts`）不是 —— 它在几小时后按 events 重跑，
   * 那时 `Date.now()` 早已跨过时段边界，会算出另一个价（方案 §5.5 的
   * 「分时段让成本不可复现」）。时刻是事实，必须随事件一起走。
   */
  atMs?: number;
  /**
   * 本条是否**已由别的路径入账**。
   *
   * `true` = 主循环（它经 `sessionState.updateUsage` + `AfterModelRaw` 入账，
   * 本事件只作为恒等式核对与归因用，消费侧**不得**再加一次钱）。
   * `false` = 主循环之外的调用链（fork / side-call / 子代理），本事件是唯一入账口。
   *
   * 这个字段就是「去重」这件事的显式表达 —— 把它写成字段而不是靠消费侧猜
   * `agentId` 是否为空，是因为将来主循环也搬过来时只需把这里改成 false。
   */
  accounted: boolean;
}

/** 计费观察者 */
export type BillingObserver = (req: BilledRequest) => void;

/**
 * **已经自己上报过成本**的调用链标签 —— 消费侧必须跳过这些，否则双记。
 *
 * ## 为什么需要这张表（它是本改造的第二个双记风险，与 `accounted` 那个正交）
 *
 * `accounted` 只解决主循环那一条：主循环经 `updateUsage` + `AfterModelRaw` 入账，
 * 所以发生侧事件对它只做恒等式核对。但**还有一类**已经入账的路径：
 * 那 18 个手写 `recordSideCall` 调用点里，有 6 条链**同时**经过
 * `streamWithResilience`（实测：`memory/recall.ts`、`query/auto-compact.ts`、
 * `query/compact/context-collapse.ts`、`query/compact/partial-compact.ts`、
 * `hook/runner.ts`、`goal/evaluator.ts`）。
 *
 * 于是同一次 fetch 会走两条入账路：
 *   ① 它自己的 `recordSideCall(...)`（老路，costUSD 已算好）
 *   ② provider 发生侧事件 → 消费侧再 `recordSideCall` 一次（新路）
 * 两条都进 `sideCostUSD` —— **成本翻倍**。这个方向的错（高估）比漏记更隐蔽：
 * 漏记有账单可对，翻倍会让人以为"修好了，数字终于上来了"。
 *
 * ## 为什么用标签白名单而不是"让 side-call 那 18 处别报了"
 *
 * `recordSideCall` 不只记钱，还记 `byLabel` 归因 / 失败 / 超时统计
 * （`trace/side-call-sink.ts`），而那些是发生侧拿不到的（发生侧只知道"这次 fetch 花了多少"，
 * 不知道"这次辅助调用整体成功没成功、超时没超时"）。所以分工是：
 * **老路继续负责归因与成败，发生侧只补它漏掉的那些链的钱。**
 *
 * ## 判据取 `callerLabel`（= `querySource`），不是 `recordSideCall` 的 `label`
 *
 * 两者命名不同（`memory_recall` vs `memory-recall`），且发生侧只拿得到前者
 * （它从 ALS 的 `RequestContext.callerLabel` 来，值就是 `streamWithResilience`
 * 的 `opts.querySource`）。所以这张表存的必须是 **querySource 的字面值**。
 *
 * ⚠️ 新增一条**自己调 recordSideCall 且走漏斗**的链时必须往这里加一个标签。
 * 这看着又是"作者要记得做一件事"（正是 §5.0 判据批判的形态），但方向是**安全的**：
 * 忘了加 → 那条链被记两次（可发现：`bun scripts/pricing-reconcile.ts` 会显示我们
 * 的账本**高于**账单）；而漏记那个方向是静默的。防漂移门禁在
 * `tests/llm/billing-self-reported-labels.test.ts`：它按"既 import recordSideCall
 * 又 import streamWithResilience"静态扫源码，扫出来的链必须在这张表里。
 */
export const BILLING_SELF_REPORTED_LABELS: ReadonlySet<string> = new Set([
  "memory_recall", // memory/recall.ts
  "compact", // auto-compact.ts / context-collapse.ts / partial-compact.ts 共用此 querySource
  "hook_agent", // hook/runner.ts
  "goal_eval", // goal/evaluator.ts
]);

/**
 * 消费侧该不该为这条事件**加钱**。
 *
 * 把判据写成函数而不是让每个消费者自己拼条件，理由与 §5.0 同一条：
 * 判据只有一份实现，才不会出现"TUI 扣了、账本没扣"这类两处不一致。
 */
export function shouldChargeBilledRequest(req: BilledRequest): boolean {
  if (req.accounted) return false; // 主循环已入账
  if (req.callerLabel && BILLING_SELF_REPORTED_LABELS.has(req.callerLabel)) return false;
  return true;
}

const observers = new Set<BillingObserver>();
/** 已见过的 fetchId（去重）。有界，见 MAX_SEEN。 */
let seen = new Set<string>();
/**
 * fetchId 去重集合上限。
 *
 * 超过即整体清空而不是 LRU 淘汰：这个集合防的是**同一条流在同一瞬间被 emit 两次**
 * （provider 的正常/异常路径都可能走到收口点），跨越几千次请求之后的重复不可能发生。
 * 无界增长在长会话里是真实泄漏（一次 fetch 一个字符串键）。
 */
const MAX_SEEN = 4096;

/** 注册计费观察者。返回反注册函数。 */
export function addBillingObserver(fn: BillingObserver): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

/**
 * 上报一次真实计费请求 —— **provider 内部调用，业务代码不要直接调**。
 *
 * 幂等：同一个 `fetchId` 重复上报只生效一次。
 * 全程 try/catch 静默：可观测性绝不影响流本身（本仓一贯口径）。
 */
export function recordBilledRequest(req: BilledRequest): void {
  try {
    if (!req.fetchId || seen.has(req.fetchId)) return;
    if (seen.size >= MAX_SEEN) seen = new Set();
    seen.add(req.fetchId);
    // 时段观测在**去重之后**：同一条流被 emit 两次时不能把高峰数记两遍。
    // 放在观察者之前：它与"谁给这笔钱记账"无关，所有 fetch 都要数（见 recordPriceTier）。
    try {
      const p = resolvePricing(req.model, undefined, req.baseURL);
      if (p) recordPriceTier(priceTierAt(p, req.atMs ? new Date(req.atMs) : undefined));
    } catch {
      /* 时段统计失败不影响入账 */
    }
    for (const fn of observers) {
      try {
        fn(req);
      } catch {
        /* 单个观察者异常不影响其余观察者 */
      }
    }
  } catch {
    /* 计费上报绝不影响流 */
  }
}

/**
 * 分时段计数（D1 / 方案 §5.5）—— 「高峰占比」这个数的采集点。
 *
 * ## 为什么计数器在这里，而不是在消费侧
 *
 * 与整个 PR3 同一条理由：**发生侧是唯一必然经过的点**。挂在消费侧（app.ts）
 * 就只能数到消费侧收到的那些，而消费侧刻意跳过了主循环（`accounted`）与
 * 6 条自报链（`BILLING_SELF_REPORTED_LABELS`）—— 那三类恰恰是请求量的大头，
 * 数出来的"高峰占比"会是一个只覆盖 fork 的偏样本。
 *
 * 所以这里数**全部** fetch，无论它的钱由谁记。时段是请求的属性，与入账路径无关。
 */
let peakCount = 0;
let tieredCount = 0;

/** 时段计数快照。`tiered` = 有分时段政策的请求数（分母），`peak` 落在高峰的那些。 */
export interface PriceTierCounts {
  peak: number;
  tiered: number;
}

/**
 * 记一次时段观测 —— 由发生侧在算出 tier 后调用。
 *
 * `"none"`（无分时段政策）**不进分母**：把它算进去会让"高峰占比"随
 * 「本会话用了多少个无分时段模型」漂移，那不是这个指标要表达的东西。
 */
export function recordPriceTier(tier: "peak" | "offpeak" | "none"): void {
  if (tier === "none") return;
  tieredCount += 1;
  if (tier === "peak") peakCount += 1;
}

export function getPriceTierCounts(): PriceTierCounts {
  return { peak: peakCount, tiered: tieredCount };
}

/**
 * 高峰请求占比（0–1）。**分母为 0 时返回 undefined，不返回 0。**
 *
 * 这个区分是刻意的：`0` 意味着"有分时段模型，且全部落在空闲时段"（一个真实的好结果），
 * `undefined` 意味着"本会话没有任何分时段模型"（无从谈起）。两者混成 0
 * 会让账本里出现一批假的"100% 空闲"会话，把高峰占比这条曲线整体拉低。
 */
export function getPeakRatio(): number | undefined {
  if (tieredCount === 0) return undefined;
  return peakCount / tieredCount;
}

/** 重置（会话切换 / 测试）。 */
export function resetBillingSink(): void {
  observers.clear();
  seen = new Set();
  peakCount = 0;
  tieredCount = 0;
}

/** 只清去重集合，保留观察者（跨会话复用同一批观察者时用）。 */
export function clearBillingDedupe(): void {
  seen = new Set();
}

let fetchSeq = 0;

/**
 * 生成一个单次 fetch 的唯一 id。
 *
 * 形态 `f<序号>-<时间戳>`：序号保证同毫秒内不撞，时间戳让离线分析能排序。
 * 刻意不用随机数 —— 可复现性对轨迹分析有价值，而这里不需要不可预测性。
 */
export function nextFetchId(): string {
  fetchSeq += 1;
  return `f${fetchSeq}-${Date.now()}`;
}
