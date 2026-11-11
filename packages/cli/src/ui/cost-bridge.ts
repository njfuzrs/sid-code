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
>;

/** 只用到 updateStreaming，避免把整个 StateBridge 契约拖进类型 */
type CostSink = Pick<StateBridge, "updateStreaming">;

export function subscribeCostToBridge(session: CostSource, bridge: CostSink): () => void {
  return session.addCostChangeListener(() => {
    bridge.updateStreaming({
      costUSD: session.getEffectiveTotalCostUSD(),
      cacheSavingsUSD: session.getTotalCacheSavings(),
      usage: { ...session.getTotalUsage() },
      totalRequests: session.getTotalRequests(),
      discardedRequests: session.getDiscardedRequests(),
    });
  });
}
