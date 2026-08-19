/**
 * latency-histograms.ts —— TTFT 与 turns 两个 Histogram（P1 · metric 侧无分布）
 *
 * ## 这两个指标为什么是这两个
 *
 * 落盘的 metric 此前 **2817 条全是 counter**、只有 3 个 metric 名，全部来自
 * `metrics/token-meter.ts`。`MetricPoint.type` 虽然声明了 `histogram`，
 * 但没有任何调用点、也无处安放分桶 —— 导出器只能把它降级成 gauge。
 *
 * 补的是**分布**而不是又一个总量：
 *
 * - **TTFT** —— 「更快」方向的主口径。必须带 model 维度，理由见
 *   `trace/latency-by-model.ts`：同一底层模型经不同网关路由，TTFB/TTFT 的语义
 *   完全不同（实测 gap 占比 86.77% vs 5.02%，差 17 倍）。**跨 model 汇总出的分位是假数**，
 *   所以这里把 model 作为标签，让后端按标签切分，而不是先汇总再看。
 * - **turns** —— 实测「轮数 vs e2e 相关系数 r = 0.767」，是端到端耗时最强的解释变量，
 *   同时是成本的最大杠杆。此前它只存在于报告层，没有进 metric。
 *
 * ## 与报告层（`trace/digest.ts` 的 `percentile()`）的分工
 *
 * **报告层不是债，是另一个消费面**，且是本仓相对同类产品的领先项 —— 本模块
 * **不替代它**，也不打算把报告层的分位全搬过来。Histogram 的唯一增量价值是
 * **让分位能被外部后端跨机器、跨版本聚合**；本地看分位 `/trace` 已经够了。
 *
 * ## 失败姿态
 *
 * 全部 try-catch 静默：可观测性绝不影响主流程。`getTelemetryBus()` 在未初始化时
 * 返回一个**禁用**的总线，`recordMetric` 内部对 `enabled=false` 直接 return，
 * 所以无条件调用是安全的，不需要调用方先判断遥测是否开着。
 */

import { getTelemetryBus } from "../index.ts";
import { TTFT_BUCKET_BOUNDS_MS, TURNS_BUCKET_BOUNDS } from "../types.ts";
import type { Attributes } from "../types.ts";

/** TTFT 分布的 metric 名（OTel GenAI 半标准命名） */
export const TTFT_METRIC = "gen_ai.client.time_to_first_token";

/** 单轮 turns 分布的 metric 名 */
export const TURNS_METRIC = "sidcode.agent.turns";

/**
 * 记录一次 TTFT 观测。
 *
 * @param ttftMs 首个**任意**内容 chunk 的到达延迟（含 thinking / tool_use）。
 *   口径必须与 `StreamPhase("first_content")` 一致 —— 只在可视文本上计会对
 *   thinking 模型和纯工具调用轮系统性虚高数十秒。
 * @param model  **必填**。没有它这个指标就是废的（见文件头：跨路由汇总是假数）。
 */
export function recordTtftHistogram(
  ttftMs: number,
  model: string,
  extra?: { provider?: string; cacheHit?: boolean },
): void {
  try {
    // 0 与负值不是"很快"，是基准时间缺失或时钟异常。落进首桶会把分布整体拉左，
    // 而这类样本恰恰应该被发现而不是被平均掉 —— 宁可不落。
    if (!Number.isFinite(ttftMs) || ttftMs <= 0) return;
    if (!model) return;

    const attributes: Attributes = { "gen_ai.request.model": model };
    if (extra?.provider) attributes["gen_ai.provider.name"] = extra.provider;
    // cache_hit 只在**已知**时才落：不知道（OpenAI 族在首内容时刻拿不到 usage）
    // 与知道且为 false 是两件事，落假的 false 会污染对照结论。
    if (extra?.cacheHit !== undefined) attributes["sidcode.cache_hit"] = extra.cacheHit;

    getTelemetryBus().recordMetric({
      name: TTFT_METRIC,
      value: ttftMs,
      timestamp: Date.now(),
      attributes,
      type: "histogram",
      buckets: { bounds: [...TTFT_BUCKET_BOUNDS_MS] },
    });
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

/**
 * 记录一轮用户消息消耗的 turns。
 *
 * 调用点在 `query/turn-complete.ts` 的 `emitTurnComplete`，与 `TurnComplete`
 * 事件同源同时刻 —— 两者数不一致时说明埋点有问题，这本身就是个可用的自检。
 *
 * @param turns      本轮的模型请求轮次
 * @param stopReason 受控值（end_turn / abort / max_turns / error / other）。
 *   **刻意用受控值而非透传 provider 的 stopReason**：透传等于把归一化责任推给
 *   每个消费方，必然漂移出多套口径。
 */
export function recordTurnsHistogram(
  turns: number,
  stopReason: string,
  extra?: { hadHitl?: boolean },
): void {
  try {
    // 0 轮是"这一轮没发生过模型请求"，不是一个耗时分布上的样本
    if (!Number.isFinite(turns) || turns <= 0) return;

    const attributes: Attributes = { "sidcode.stop_reason": stopReason };
    // had_hitl 让消费侧能排除"含人等待"的样本 —— 用户去喝咖啡了也算进分布的话，
    // 这条曲线量的就不再是系统性能。
    if (extra?.hadHitl !== undefined) attributes["sidcode.had_hitl"] = extra.hadHitl;

    getTelemetryBus().recordMetric({
      name: TURNS_METRIC,
      value: turns,
      timestamp: Date.now(),
      attributes,
      type: "histogram",
      buckets: { bounds: [...TURNS_BUCKET_BOUNDS] },
    });
  } catch {
    /* 可观测性不影响正常流程 */
  }
}
