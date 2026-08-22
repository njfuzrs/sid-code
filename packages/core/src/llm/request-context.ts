/**
 * 请求级上下文（PR2 / 方案 §5.2.2 ③）—— 归因的单一事实源。
 *
 * ## 它替代的是什么
 *
 * `sse-chunk-dumper.ts` 的 `ambientCtx` 是一个**模块级可变全局量**，
 * 全仓只有主循环一个写入点（`query/loop.ts` 的 `setSseDumpContext`）。
 * 后果是所有非主循环路径（fork / 子代理 / side-call）发的流，
 * 都会**继承主循环最后一次登记的 `turnIndex`**。
 *
 * 实测形态（会话 `20260821-140626-4fd1f34e`）：两个 fork 在 `end_turn` 后发的 7 个流
 * 全部落在主循环最后一轮的 `index=17` 上，与主循环共用同一个 attempt 计数器，
 * 于是 attempt 单调涨到 8 —— **在轨迹里长得完全就是"一个请求重试了 8 次"**。
 * 这一层不造成额外花费，但它让白烧在轨迹里隐身，所以这个缺陷能长期潜伏。
 *
 * ## 为什么是 AsyncLocalStorage 而不是"逐层传参"
 *
 * 逐层传参要穿过 `runForkedAgent → streamWithResilience → ModelFallback →
 * provider.sendMessageStream → parseSSE` 五层，且**每条新增调用链的作者都得记得传**
 * —— 与本次事故同型（`recordSideCall` 的 18 个手写调用点就是那个形态的代价）。
 * ALS 让身份跟着**执行上下文**走：调用方只在自己的入口 `withRequestContext(...)` 一次，
 * 内部任意深度的 provider 调用都自动读到对的身份，**不需要记得任何事**。
 *
 * 仓库已有两处同款先例：`bootstrap/cwd-context.ts` 与 `swarm/team-context.ts`。
 *
 * ## 兼容契约（这条决定了改造的安全性）
 *
 * `getRequestContext()` 在 ALS 为空时返回 `undefined`，消费侧一律回落到
 * `currentSseDumpContext()` 的旧全局量 —— 于是**主循环路径行为逐字节不变**
 * （主循环不进 ALS，继续用它自己那套 setSseDumpContext）。
 * 只有显式包了 `withRequestContext` 的路径（fork / 子代理 / side-call）才拿到新身份。
 *
 * ⚠️ 低依赖铁律：本模块**只 import node 内置**，不 import 任何业务模块。
 * `trace/stream-observer.ts` 已经 import 了 `llm/sse-chunk-dumper.ts`，
 * 再引一个带业务依赖的模块会成环。
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 一次调用链的身份。
 *
 * 字段语义刻意与 `makeSnapshotKey(loopId, index, agentId)` 对齐 —— 归因维度与
 * 快照/attempt 的键维度必须是同一套，否则"写进去读不到"（那比不写更糟：假装刷新过）。
 */
export interface RequestContext {
  /** queryLoop 实例 id（快照 namespace 隔离用）。缺省沿用全局量的 loopId。 */
  loopId?: string;
  /** 观测 index（= 旧 `turnIndex`）。fork / side-call 应给自己独立的号段。 */
  turnIndex: number;
  /** 会话 id（SSE dump 落盘定位用） */
  sessionId?: string;
  /**
   * 调用链身份 —— 快照/attempt key 的第三维。
   *
   * **这是幽灵流归因的关键字段**：有它，fork 的流才不会与主循环共用 attempt 计数器。
   */
  agentId?: string;
  /**
   * 调用方标签（`session-memory-update` / `memory-extract` / `recall` / 主循环为
   * `undefined`）。计费事件带上它，"这笔钱是谁花的"才答得出来 —— 判据 3 就是它。
   */
  callerLabel?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * 在给定身份下执行 fn。fn 内部（含任意深度的 await）都能读到该身份。
 *
 * ⚠️ **必须包住整个流的消费过程，不能只包"构造 generator"那一句**。
 * `sendMessageStream` 是惰性 async generator 工厂：只调用它不会执行任何 body，
 * 真正读 ALS 的代码在 `for await` 拉取时才跑。只包工厂调用等于什么都没包
 * （这个坑 `fallback.ts:921` 的注释已经记过一次，形态相同）。
 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 读当前请求身份；未包在 `withRequestContext` 里时返回 undefined（消费侧回落旧全局量）。 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * 把一个 async generator 包进给定身份 —— **流式路径专用**。
 *
 * ## 为什么不能只 `withRequestContext(ctx, () => makeStream())`
 *
 * `sendMessageStream` 与漏斗返回的都是**惰性** async generator：调用工厂函数时
 * body 一行都不执行，真正读 ALS 的代码在下游 `for await` 拉取时才跑。而 `.next()`
 * 是**调用方**发起的，跑在调用方的 async context 里 —— 于是只包工厂调用等于什么都没包。
 *
 * 修法是逐次 pull 都进 store：`storage.run(ctx, () => inner.next())`。
 * generator body 从 `.next()` 同步恢复执行，其内部的 await 点也就在 store 里建立，
 * 后续恢复自动沿用 —— 整条 body 全程可见身份。
 *
 * `return` / `throw` 也一并包：提前 break（下游 `break` 会触发 `.return()`）时
 * generator 的 `finally` 块会跑，而**计费收口正是挂在 provider 的 finally 里**。
 * 不包这两个，提前 break 的流会丢掉身份、被误判成主循环的流。
 */
export async function* streamInRequestContext<T>(
  ctx: RequestContext,
  make: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const inner = storage.run(ctx, make);
  try {
    while (true) {
      const r = await storage.run(ctx, () => inner.next());
      if (r.done) return;
      yield r.value;
    }
  } catch (err) {
    // 把异常也在 store 内交给 inner 收尾（它的 finally 要发计费事件）
    if (inner.throw) {
      await storage.run(ctx, () => inner.throw!(err)).catch(() => {});
    }
    throw err;
  } finally {
    if (inner.return) {
      await storage.run(ctx, () => inner.return!(undefined as never)).catch(() => {});
    }
  }
}
