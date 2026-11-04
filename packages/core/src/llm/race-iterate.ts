/**
 * 可中断迭代原语 —— race-iterate.ts
 *
 * § 为什么需要它（会话 20261103-213816-f5beebde 复盘 F1）
 *
 * 本仓有四处「手动迭代 + Promise.race(abortPromise)」的手抄循环，它们各自解决了
 * 「source 半开时 reader.read() 永不 settle，signal 检查永远执行不到」这一半问题，
 * 却**都漏了另一半**：消费方抛错 / 提前 break 时不对源迭代器调 `return()`。
 *
 * 漏掉的后果不是内存少回收一点，而是**整条生成器链的 finally 集体不执行**：
 *   1. `fallback.ts` 收到 provider 的 `error` 事件后 `throw NormalizedErrorCarrier`
 *      —— 它手里那个 `iterator` 被丢弃，provider 生成器永远停在 `yield` 上；
 *   2. provider 内部的 `for await (… of lifecycle.guard(…))` 因此也不会去
 *      `return()` lifecycle 生成器；
 *   3. lifecycle 的 `finally`（clearTimers / releaseSleepObserver / stream_completed）
 *      永不执行 → idle 定时器 240s 后照样开枪（幽灵 TimeoutFired）、stall interval
 *      永久刷屏、`BilledRequest` 不写（计费恒等式少条）。
 *
 * 实测证据：10 次 `unrecognized_error`（Response failed）到对应 `TimeoutFired` 的间隔
 * 是 239.998s / 240.001s / 240.001s / 240.000s / …，**正好等于 idle 阈值**，即
 * 定时器是从「流被放弃那一刻」起算的，不是在流还活着时开的枪。全仓
 * `.return(` / `iterator.return` 命中数为 0。
 *
 * § 它自己必须是生成器
 *
 * 这是修法成立的关键：只有本函数也是 async generator，消费方的 `throw` / `break`
 * 才会触发**它**的 `finally`，从而把 `return()` 一层层传下去。若写成普通
 * async 函数（返回一个迭代器），消费方丢弃它时同样什么都没发生 —— 泄漏只是换了个位置。
 *
 * § finally 里刻意不 `await it.return()`
 *
 * 源头卡在一个永不 settle 的 `await` 上时，`return()` 本身也不会 resolve（已实测：
 * `return while awaiting resolved? false`）。await 它等于把挂起从「泄漏」挪到「退出路径」，
 * 消费方会跟着一起挂住。真正的 I/O 取消是调用方 `cancelSource` 的职责，
 * 本层只保证「请求了收尾」这件事一定发生。
 */

/** raceIterate 的中断源：任一 promise reject 即立刻结束迭代。 */
export interface RaceIterateOptions {
  /**
   * 中断用的 promise（abort race / 超时 race）。它们通常是**永不 resolve、只 reject**
   * 的 promise，因此可以安全地在每一轮 `next()` 中重复参与 race。
   *
   * 错误类型由调用方决定，本函数原样抛出 —— 四处调用点现有的 abort 语义
   *（`RequestAbortedError` + `abortReason`、lifecycle 的 `StreamLifecycleTimeoutError`）
   * 都保持不变。
   */
  interrupts?: ReadonlyArray<Promise<never>>;
  /**
   * L1（2026-11-04）：迭代结束（无论正常结束 / 消费方 break / 消费方 throw / 中断 reject）
   * 时调用一次。用于释放中断源自身的资源（典型：`createAbortRaceInterrupt().dispose`）。
   *
   * 为什么不要求调用方自己写 try/finally 包住 `for await`：四处调用点的循环体动辄
   * 上百行，包一层会把整个函数重排；而漏包一次的后果正是历史缺陷的形态
   *（`{ once: true }` 只在 abort 时移除，正常完成时永久泄漏）。
   * 把「离开时一定执行」交给本函数的 finally，与「离开时一定 return() 源头」同源。
   */
  onExit?: () => void;
}

/**
 * 消费 `source` 并把每个元素透传给调用方，同时保证**无论以何种方式离开**
 *（源正常结束 / 消费方 `break` / 消费方 `throw` / `interrupts` reject）
 * 都对源迭代器请求一次 `return()`，让源头的 `finally` 得以执行。
 *
 * 用法与普通 `for await` 完全一致：
 * ```ts
 * for await (const ev of raceIterate(stream, { interrupts: [abortPromise] })) { … }
 * ```
 */
export async function* raceIterate<T>(
  source: AsyncIterable<T>,
  opts: RaceIterateOptions = {},
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const interrupts = opts.interrupts ?? [];
  // L2（2026-11-04）：入口把多个中断源合并成**一个** promise。
  //
  // `Promise.race` 会给每个参与项附一对 then handler。中断源是「永不 resolve、只 reject」
  // 的长生命周期 promise，而本函数每取一个事件就 race 一次 —— 不合并时一个 N 事件的流
  // 会在 M 个中断源上各堆 N 个 handler（O(N×M)）。合并后入口只附 M 个，之后每轮只对
  // 合并后的那一个附 handler（O(N + M)）。量级不改变功能，但这是「每个事件都多分配
  // M 个对象」的常数开销，长流上会累积成 MB 级。
  const interrupt =
    interrupts.length === 0
      ? null
      : interrupts.length === 1
        ? interrupts[0]!
        : Promise.race(interrupts);
  // 源已自己结束（done: true）：此时不需要也不应该再调 return() ——
  // 对已完成的迭代器重复收尾虽多为 no-op，但对「带 I/O 副作用的自定义迭代器」
  //（例如 return() 会 cancel 底层流）语义就变成了「正常结束也当成放弃」。
  let sourceExhausted = false;
  try {
    while (true) {
      const next = iterator.next();
      // 没有中断源时不做多余的 Promise.race（race 会多分配一个 promise，
      // 且把 next 的 rejection 多套一层，堆栈不好认）。
      const result = interrupt ? await Promise.race([next, interrupt]) : await next;
      if (result.done) {
        sourceExhausted = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!sourceExhausted) {
      // `void` + catch：不 await（理由见文件头），也不让 return() 自身的 rejection
      // 变成 unhandledRejection 把进程带走。
      try {
        const returned = iterator.return?.();
        if (returned && typeof (returned as Promise<unknown>).catch === "function") {
          void (returned as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* 同步抛出的 return() 同样不能污染退出路径 */
      }
    }
    // L1：释放中断源自身的资源。与上面 return() 同理 —— 释放失败不能污染退出路径
    //（否则会盖掉消费方真正关心的那个异常）。
    try {
      opts.onExit?.();
    } catch {
      /* 释放失败不影响退出路径 */
    }
  }
}

/** 由 AbortSignal 驱动的 raceIterate 中断源（含配套的 listener 释放）。 */
export interface AbortRaceInterrupt {
  /** 中断 promise；signal 未提供或已 abort 时为 null（调用方无须再 race）。 */
  interrupt: Promise<never> | null;
  /** 移除 signal 上的 listener。正常结束 / 异常退出都必须调用（幂等，可重复调）。 */
  dispose: () => void;
}

/**
 * 创建「AbortSignal → raceIterate 中断源」的配对 add/remove。
 *
 * ## 为什么必须配对（L1，2026-11-04）
 *
 * `{ once: true }` 只在 **abort 真的发生**时移除 listener。请求正常结束（绝大多数请求）
 * 时没有一处 `removeEventListener`，于是每个请求在会话级 signal 上留下一个永久 listener：
 * 闭包持有 `reject` 与错误构造参数，`stream-lifecycle` 那处还持有整个 lifecycle 的定时器
 * 与状态引用。
 *
 * 更糟的是它**完全静默**：`AbortSignal` 是 `EventTarget` 不是 Node 的 `EventEmitter`，
 * 没有 MaxListeners 警告。长会话（几百次模型调用）线性累积，只能靠 heap snapshot 看出来。
 *
 * ## 为什么做成工厂而不是让调用方各写一份
 *
 * 四个调用点（`fallback` 流式 / `fallback` 非流式 / `stream-processor` / `stream-lifecycle`）
 * 的错误类型与措辞各不相同，但「add 之后必须 remove」这件事完全同构。各写一份的结果是
 * 历史已经证明的：四处都漏了 remove。
 *
 * @param signal  外部中断信号；未提供或已 abort 时返回 `interrupt: null`
 * @param makeError 中断时构造的错误（延迟到 abort 那一刻才调用，与改造前一致）
 */
export function createAbortRaceInterrupt(
  signal: AbortSignal | undefined,
  makeError: () => Error,
): AbortRaceInterrupt {
  if (!signal || signal.aborted) return { interrupt: null, dispose: () => {} };
  let onAbort: (() => void) | null = null;
  const interrupt = new Promise<never>((_, reject) => {
    onAbort = () => reject(makeError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    interrupt,
    dispose: () => {
      if (onAbort === null) return;
      signal.removeEventListener("abort", onAbort);
      onAbort = null;
    },
  };
}
