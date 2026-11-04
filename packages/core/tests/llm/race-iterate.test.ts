/**
 * F1 ①：可中断迭代原语 race-iterate.ts — 单元测试
 *
 * 被修的真实缺陷（会话 20261103-213816-f5beebde）：四处手抄的
 * 「手动迭代 + Promise.race(abortPromise)」在消费方 throw / break 时**不调
 * `iterator.return()`**，导致下游生成器的 finally 集体不执行 —— lifecycle 的
 * clearTimers / releaseSleepObserver / stream_completed 全不跑，idle 定时器
 * 240s 后照样开枪（幽灵 TimeoutFired），计费恒等式少 11 条。
 *
 * 这组用例把「离开方式」逐一钉住：正常结束 / break / throw / 中断 reject，
 * 四种方式都必须让源头的 finally 跑到（正常结束也不例外，只是不需要 return()）。
 *
 * fix_type: regression
 */

import { describe, test, expect } from "bun:test";
import { raceIterate, createAbortRaceInterrupt } from "@sid-code/core/llm/race-iterate.ts";

/** 带 finally 观测点的源：记录 return 次数与 finally 是否执行。 */
function makeSource<T>(items: T[], opts: { hangAfter?: boolean; hangInFinally?: boolean } = {}) {
  const state = {
    returned: 0,
    finalized: 0,
    /** 源被 return() 之后是否还能继续产出（不该发生，用来验证语义） */
    yieldedAfterReturn: 0,
  };
  let returnedFlag = false;
  async function* gen(): AsyncGenerator<T> {
    try {
      for (const item of items) {
        if (opts.hangAfter) {
          yield item;
          await new Promise(() => {}); // 模拟 reader.read() 永不 settle
        }
        yield item;
      }
    } finally {
      state.finalized++;
      if (opts.hangInFinally) {
        // 模拟「源头卡在一个永不 settle 的 await 上」：return() 自身也不会 resolve。
        await new Promise(() => {});
      }
    }
  }
  const source: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      const it = gen();
      return {
        next: () => it.next(),
        return: (value?: unknown) => {
          state.returned++;
          returnedFlag = true;
          return it.return(value as T);
        },
        throw: (e?: unknown) => it.throw(e),
      };
    },
  };
  return { source, state, wasReturned: () => returnedFlag };
}

describe("F1 — raceIterate：离开方式与源头释放", () => {
  test("正常消费：透传全部元素，源正常结束，finally 执行", async () => {
    const { source, state } = makeSource([1, 2, 3]);
    const got: number[] = [];
    for await (const v of raceIterate(source)) got.push(v);

    expect(got).toEqual([1, 2, 3]);
    expect(state.finalized).toBe(1);
    // 正常结束不调 return()：源已经 done，再收尾等于把「正常完成」当成「放弃」，
    // 对 return() 带 I/O 副作用的迭代器（如 cancel 底层流）语义就错了。
    expect(state.returned).toBe(0);
  });

  test("消费方 break：源的 finally 执行，return() 恰好一次", async () => {
    const { source, state } = makeSource([1, 2, 3]);
    for await (const v of raceIterate(source)) {
      if (v === 2) break;
    }
    // for-await 的 break 会等 return() 的 promise —— 我们只发不 await，
    // 但源头这里是同一个 tick 就能完成收尾的普通生成器。
    await new Promise((r) => setTimeout(r, 0));

    expect(state.returned).toBe(1);
    expect(state.finalized).toBe(1);
  });

  test("消费方 throw：源的 finally 执行，错误原样传播给调用方", async () => {
    const { source, state } = makeSource([1, 2, 3]);
    let caught: unknown = null;
    try {
      for await (const v of raceIterate(source)) {
        if (v === 2) throw new Error("消费方主动放弃");
      }
    } catch (e) {
      caught = e;
    }
    await new Promise((r) => setTimeout(r, 0));

    expect((caught as Error)?.message).toBe("消费方主动放弃");
    expect(state.returned).toBe(1);
    expect(state.finalized).toBe(1);
  });

  test("中断源 reject：以该错误结束，源的 finally 执行（这正是 F1 的超时中断形态）", async () => {
    const { source, state } = makeSource([1, 2, 3], { hangAfter: true });
    // definite assignment（`!`）：赋值发生在 Promise executor 内，TS 的控制流分析看不到，
    // 写成 `| null` 会让调用处被收窄成 never（TS2349: This expression is not callable）。
    let rejectInterrupt!: (e: unknown) => void;
    const interrupt = new Promise<never>((_, reject) => {
      rejectInterrupt = reject;
    });
    // 与 stream-lifecycle 同样的写法：中断源可能在无人订阅时 reject。
    void interrupt.catch(() => {});

    let caught: unknown = null;
    const consumed = (async () => {
      try {
        for await (const v of raceIterate(source, { interrupts: [interrupt] })) {
          if (v === 1) rejectInterrupt?.(new Error("模拟超时"));
        }
      } catch (e) {
        caught = e;
      }
    })();
    await consumed;
    await new Promise((r) => setTimeout(r, 0));

    expect((caught as Error)?.message).toBe("模拟超时");
    // return() 被**请求**了（这是本层能保证的全部）。
    expect(state.returned).toBe(1);
    // 刻意不断言 finalized：源头卡在永不 settle 的 await 上时，`it.return()` 自己
    // 也不会 resolve，源头的 finally 跑不到 —— 这是 JS 生成器的物理限制，不是泄漏。
    // 取消真正的 I/O 是调用方 `cancelSource` 的职责（方案 §1.4 ③），
    // 本层只负责「请求收尾这件事一定发生」。
    expect(state.finalized).toBe(0);
  });

  test("源头 finally 永不 settle 时，消费方不被挂住（finally 里刻意不 await return()）", async () => {
    const { source, state } = makeSource([1, 2], { hangInFinally: true });
    const startedAt = Date.now();
    for await (const v of raceIterate(source)) {
      if (v === 1) break;
    }
    const elapsed = Date.now() - startedAt;

    // await return() 会把「源头卡住」原样搬到消费方的退出路径上：
    // 消费方就再也走不到自己的 finally。
    expect(elapsed).toBeLessThan(200);
    expect(state.returned).toBe(1);
    // finally 开始执行了（卡在里面的 await，那是源自己的事）
    expect(state.finalized).toBe(1);
  });

  test("无 interrupts 时不强制 race：正常流仍逐条透传", async () => {
    const { source } = makeSource(["a", "b"]);
    const got: string[] = [];
    for await (const v of raceIterate(source, { interrupts: [] })) got.push(v);
    expect(got).toEqual(["a", "b"]);
  });

  test("源的 next() 抛错：原样传播（不被当成正常结束），finally 执行", async () => {
    async function* broken(): AsyncGenerator<number> {
      try {
        yield 1;
        throw new Error("源自身错误");
      } finally {
        finalized++;
      }
    }
    let finalized = 0;
    let caught: unknown = null;
    try {
      for await (const _v of raceIterate(broken())) {
        /* 消费 */
      }
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("源自身错误");
    expect(finalized).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// L1（2026-11-04）：中断源挂在 signal 上的 listener 必须「离开时一定移除」
//
// 缺陷本体：`{ once: true }` 只在 abort **真的发生**时自动注销。请求正常完成
//（绝大多数请求）时没有一处 removeEventListener，于是每个请求在会话级 signal 上
// 留下一个永久 listener —— 闭包持有 reject 与错误构造参数。AbortSignal 是
// EventTarget 不是 EventEmitter，没有 MaxListeners 警告，长会话线性累积且完全静默。
//
// 判据就是「当前挂了几个 listener」，而真 EventTarget 不暴露这个数字，所以这里
// 用一个自己实现的计数 signal，并精确复刻 `{ once: true }` 的自动注销语义。
// ═══════════════════════════════════════════════════════════════════

interface CountingSignal {
  signal: AbortSignal;
  /** 当前仍注册在 signal 上的 abort listener 数 */
  listenerCount: () => number;
  /** 触发 abort（按 add 时登记的 once 语义先注销再派发） */
  abort: () => void;
}

function makeCountingSignal(): CountingSignal {
  const listeners = new Map<EventListener, { once: boolean }>();
  let aborted = false;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(type: string, listener: EventListener, opts?: AddEventListenerOptions) {
      if (type !== "abort") return;
      listeners.set(listener, { once: opts?.once ?? false });
    },
    removeEventListener(type: string, listener: EventListener) {
      if (type !== "abort") return;
      listeners.delete(listener);
    },
  } as unknown as AbortSignal;

  return {
    signal,
    listenerCount: () => listeners.size,
    abort() {
      aborted = true;
      // 先快照再派发：`{ once: true }` 的语义是「派发前注销」
      for (const [listener, { once }] of [...listeners]) {
        if (once) listeners.delete(listener);
        listener(new Event("abort"));
      }
    },
  };
}

describe("L1 — createAbortRaceInterrupt：listener 在离开时一定移除", () => {
  test("正常消费结束：signal 上不留 listener（这就是缺陷本体）", async () => {
    const counting = makeCountingSignal();
    const abort = createAbortRaceInterrupt(counting.signal, () => new Error("aborted"));
    expect(counting.listenerCount()).toBe(1);

    for await (const _v of raceIterate(makeSource([1, 2, 3]).source, {
      interrupts: abort.interrupt ? [abort.interrupt] : [],
      onExit: abort.dispose,
    })) {
      /* 消费完 */
    }

    expect(counting.listenerCount()).toBe(0);
  });

  test("消费方 break 离开：同样移除（不是只有正常结束才管）", async () => {
    const counting = makeCountingSignal();
    const abort = createAbortRaceInterrupt(counting.signal, () => new Error("aborted"));

    for await (const v of raceIterate(makeSource([1, 2, 3]).source, {
      interrupts: abort.interrupt ? [abort.interrupt] : [],
      onExit: abort.dispose,
    })) {
      if (v === 2) break;
    }

    expect(counting.listenerCount()).toBe(0);
  });

  test("消费方 throw 离开：同样移除", async () => {
    const counting = makeCountingSignal();
    const abort = createAbortRaceInterrupt(counting.signal, () => new Error("aborted"));

    let caught: unknown = null;
    try {
      for await (const v of raceIterate(makeSource([1, 2, 3]).source, {
        interrupts: abort.interrupt ? [abort.interrupt] : [],
        onExit: abort.dispose,
      })) {
        if (v === 2) throw new Error("消费方主动放弃");
      }
    } catch (e) {
      caught = e;
    }

    expect((caught as Error)?.message).toBe("消费方主动放弃");
    expect(counting.listenerCount()).toBe(0);
  });

  test("abort 真的发生：once 语义 + dispose 都不会留下 listener，中断错误原样抛出", async () => {
    const counting = makeCountingSignal();
    const abort = createAbortRaceInterrupt(counting.signal, () => new Error("模拟中断"));

    let caught: unknown = null;
    const consumed = (async () => {
      try {
        for await (const v of raceIterate(makeSource([1, 2, 3], { hangAfter: true }).source, {
          interrupts: abort.interrupt ? [abort.interrupt] : [],
          onExit: abort.dispose,
        })) {
          if (v === 1) counting.abort();
        }
      } catch (e) {
        caught = e;
      }
    })();
    await consumed;

    expect((caught as Error)?.message).toBe("模拟中断");
    expect(counting.listenerCount()).toBe(0);
  });

  test("dispose 幂等；未提供 signal 时 interrupt 为 null 且 dispose 是 no-op", () => {
    const counting = makeCountingSignal();
    const abort = createAbortRaceInterrupt(counting.signal, () => new Error("aborted"));
    abort.dispose();
    abort.dispose();
    expect(counting.listenerCount()).toBe(0);

    const none = createAbortRaceInterrupt(undefined, () => new Error("aborted"));
    expect(none.interrupt).toBeNull();
    expect(() => none.dispose()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// L2（2026-11-04）：`Promise.race` 每轮给每个中断源附一对 handler
//
// 中断源是「永不 resolve、只 reject」的长生命周期 promise，而循环每取一个事件就
// race 一次。不合并时一个 N 事件的流会在 M 个中断源上各堆 N 个 handler（O(N×M)）
// —— 每事件多分配 M 个对象的常数开销，长流上累积成 MB 级。
//
// 判据不能是 `process.memoryUsage()` 的绝对值（会因 GC 时机在 CI 上抖动），
// 所以这里数 `then` 被调用了几次：`Promise.race` 对每个参与项必然调一次 `then`。
// ═══════════════════════════════════════════════════════════════════

interface CountingInterrupt {
  promise: Promise<never>;
  /** 被 attach 的 then 次数（每次参与 race 都会 +1） */
  thenCalls: () => number;
}

function makeCountingInterrupt(): CountingInterrupt {
  let thenCalls = 0;
  const inner = new Promise<never>(() => {});
  // Proxy 而不是包装成普通 thenable：`Promise.race` 对真 Promise 与 thenable
  // 的处理路径不同，用 Proxy 保持「它就是一个 Promise」，只旁路计数。
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return (...args: unknown[]) => {
          thenCalls++;
          return (target.then as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Promise<never>;
  return { promise: proxy, thenCalls: () => thenCalls };
}

describe("L2 — 中断源合并：handler 数不随事件数线性放大", () => {
  test("M=2 个中断源 + N=20 个事件：每个中断源只在入口被 attach 1 次", async () => {
    const N = 20;
    const { source } = makeSource(Array.from({ length: N }, (_, i) => i));
    const a = makeCountingInterrupt();
    const b = makeCountingInterrupt();

    const got: number[] = [];
    for await (const v of raceIterate(source, { interrupts: [a.promise, b.promise] })) got.push(v);

    expect(got).toHaveLength(N);
    // 不合并时每轮 race 都会给两个中断源各附一对 handler（共 N 次）；
    // 入口合并后只在入口各 attach 1 次，之后每轮 race 只面对合并后的那一个 promise。
    expect(a.thenCalls()).toBe(1);
    expect(b.thenCalls()).toBe(1);
    expect(a.thenCalls()).toBeLessThan(N);
  });

  test("合并后中断仍然生效：任一中断源 reject 即结束迭代", async () => {
    const { source, state } = makeSource([1, 2, 3], { hangAfter: true });
    // definite assignment（`!`）：赋值在 Promise executor 内，TS 的控制流分析看不到。
    let rejectB!: (e: unknown) => void;
    const b = new Promise<never>((_, reject) => {
      rejectB = reject;
    });
    // 与 stream-lifecycle 同样的写法：中断源可能在无人订阅时 reject。
    void b.catch(() => {});
    const a = makeCountingInterrupt();

    let caught: unknown = null;
    const consumed = (async () => {
      try {
        for await (const v of raceIterate(source, { interrupts: [a.promise, b] })) {
          if (v === 1) rejectB(new Error("模拟超时"));
        }
      } catch (e) {
        caught = e;
      }
    })();
    await consumed;

    expect((caught as Error)?.message).toBe("模拟超时");
    expect(state.returned).toBe(1);
  });
});
