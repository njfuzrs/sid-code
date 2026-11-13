/**
 * 入账 → 状态栏（D1）：把 SessionState 的**每一笔**入账推成 TUI 状态里的费用/用量字段。
 *
 * 为什么需要这条接线：费用列此前只在五个固定时机重新读值（tool_end / done / 轮末
 * finally / 中断 catch / 首帧），而辅助调用（后台记忆 fork、标题生成、SessionEnd 前的
 * 收尾调用）走的是 `addSideCost`，不经过这五个时机。于是**一轮结束之后才入账的那部分
 * 永远推不到 UI**——实测一次会话 Footer 停在 $0.0856、真实 $0.1501（少报 43%），
 * 且用户不再输入就永不更新，要等到下一轮第一个工具结束才一次性跳上去。
 *
 * 为什么单独成模块而不是内联在 app.ts：这条链路跨 core（SessionState）/ cli
 * （StateBridge）/ UI（Footer）三层，内联写法只能靠「测试里把同样的代码再抄一遍」，
 * 那样测到的是抄件而不是真实接线。抽成函数后单测能直接复刻 app.ts 的接线。
 *
 * 三条不能改的约定：
 * - **不推 stockInputTokens**：「当前上下文大小」只随主循环变化，辅助调用不改上下文。
 *   推它会让状态栏 ↑ 在唯一该稳定的时刻抖动。
 * - **走 updateStreaming 而不是 updateState**：主循环每个请求也会触发入账，逐笔
 *   emit 会让整棵 App 树 reconcile；updateStreaming 是 32ms 固定窗口合帧、尾沿必触发。
 * - **返回值必须被调用**（TUI 卸载后反注册）：SessionEnd 前的收尾调用仍会入账，
 *   那时 bridge 已不再渲染，继续写只是往没人消费的状态里灌值。
 *
 * 吞吐也走这条线（`outputTps`）：它的更新时机天生与入账同步——累计值只在该轮
 * `stream_completed` 之后变一次，而那次累加就发生在主循环 `updateUsage()`（= 入账）之前。
 * 因此不需要新的事件源，也不需要 32ms 合帧之外的高频推送：**读数每轮最多变一次**。
 * getter 由调用方注入（`() => traceCollector?.getOutputTps()`），本模块不认识 trace 层，
 * 单测可以直接传一个假 getter —— 接的是「谁提供数」，不是「数从哪算」。
 *
 * D18：命中率也在这里推（`cacheHitRate`），且**只推 core 算好的那个数**。
 * 状态栏此前自己拿「全会话合计 usage + 当前模型推断的 provider」重算，单模型会话看不出问题，
 * 但会话里换过模型、或主模型与子代理协议族不同时，anthropic 的 `input`（未命中余量）会被
 * 当成 openai 的 `prompt_tokens`（含命中），命中率直接算错——同一个指标两种算法，
 * 而 /cost 用的 `getNormalizedCacheUsage()`（按每个模型自己的 provider 归一化后加总）才是对的。
 */

import type { SessionState } from "@sid-code/core/session/state.ts";
import type { StateBridge } from "./state-bridge.ts";

/** 只需要 SessionState 的读接口 + 订阅接口，测试可传真实实例 */
type CostSource = Pick<
  SessionState,
  | "addCostChangeListener"
  | "getEffectiveTotalCostUSD"
  | "getTotalCacheSavings"
  | "getTotalUsage"
  | "getTotalRequests"
  | "getDiscardedRequests"
  | "getCacheHitRate"
>;

/** 只用到 updateStreaming，避免把整个 StateBridge 契约拖进类型 */
type CostSink = Pick<StateBridge, "updateStreaming">;

export function subscribeCostToBridge(
  session: CostSource,
  bridge: CostSink,
  /** 会话输出吞吐 getter（`TraceCollector.getOutputTps()`）。省略则不推该列。 */
  getOutputTps?: () => number | undefined,
): () => void {
  return session.addCostChangeListener(() => {
    bridge.updateStreaming({
      costUSD: session.getEffectiveTotalCostUSD(),
      cacheSavingsUSD: session.getTotalCacheSavings(),
      usage: { ...session.getTotalUsage() },
      totalRequests: session.getTotalRequests(),
      discardedRequests: session.getDiscardedRequests(),
      // D18：命中率只推 core 算好的那个数（`SessionState.getCacheHitRate()`，按每个模型
      // 自己的 provider 归一化后加总，与 /cost 同一个数）。UI 层不许再拿 usage + 当前模型
      // 推断的 provider 重算——多模型/跨协议族会话那样算会错。
      cacheHitRate: session.getCacheHitRate(),
      // 每笔入账都重读一次：该轮若刚结束，这里拿到的就是含本轮样本的最新累计均值；
      // 若这轮还没结束（如辅助调用入账），读到的是上一轮的均值，不会倒退成 0。
      outputTps: getOutputTps?.(),
    });
  });
}
