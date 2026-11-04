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
import { raceIterate } from "@sid-code/core/llm/race-iterate.ts";

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
