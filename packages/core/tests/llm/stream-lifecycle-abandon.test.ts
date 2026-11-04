/**
 * F1（会话 20261103-213816-f5beebde 复盘）：流迭代器放弃时释放源头 + lifecycle 超时可中断
 *
 * 这组用例钉住的是**两种形态**（方案 §1.2）：
 *
 *   形态 B（本会话实际触发）—— 消费方收到 `error` 事件后 throw，把 lifecycle 生成器
 *   丢在 `yield` 处，从不调 `return()`。改造前整条链的 finally 集体不执行：
 *   stall interval 永久刷屏、idle 定时器 240s 后开枪（幽灵 TimeoutFired）、
 *   `stream_completed` / `BilledRequest` 永远不发。
 *
 *   形态 A —— 源头 `reader.read()` 挂住时，超时只置标志不打断 `await`，循环出不来。
 *
 * 关键断言口径（不是"看起来没报错"）：
 *   - stall 计数在放弃后**不再增长**（不是「总数小」）
 *   - `onTimeout` 完全不被调用（不是「晚一点才触发」）
 *   - `stream_completed` 恰好一次
 *   - 超时以 `StreamLifecycleTimeoutError` 结束（不是「流正常结束」）
 *   - `cancelSource` 恰好一次
 *
 * fix_type: regression
 */

import { describe, test, expect } from "bun:test";
import {
  createStreamLifecycle,
  getActiveStreamLifecycleCount,
} from "@sid-code/core/llm/stream-lifecycle.ts";
import { raceIterate } from "@sid-code/core/llm/race-iterate.ts";
import { StreamLifecycleTimeoutError } from "@sid-code/core/llm/errors.ts";
import { normalizeThrown, classifyFamily } from "@sid-code/core/llm/error-normalize.ts";
import type { StreamTelemetrySignal } from "@sid-code/core/llm/types.ts";

interface Evt {
  type: string;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("F1 形态 B — 消费方放弃时源头被释放（finally 必须执行）", () => {
  test("漏斗在 error 事件上 throw：provider 与 lifecycle 的 finally 都执行，stall 停止，无幽灵超时", async () => {
    const counters = {
      providerFinalized: 0,
      lifecycleFinalized: 0, // = stream_completed 次数
      stalls: 0,
      timeouts: 0,
      cancelCalled: 0,
    };
    // 源头：先给一个真内容，再给一个 error，然后**永不产出**（模拟 SSE 半开）。
    const source = async function* (): AsyncGenerator<Evt> {
      try {
        yield { type: "content_block_delta" };
        yield { type: "error" };
        await new Promise(() => {});
      } finally {
        counters.lifecycleFinalized++;
      }
    };
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 120,
      stallWarnMs: 25,
      label: "F1-TEST",
      cancelSource: () => counters.cancelCalled++,
      onTimeout: () => counters.timeouts++,
      onTelemetry: (e: StreamTelemetrySignal) => {
        if (e.type === "stream_stall") counters.stalls++;
      },
    });
    // provider 生成器：内部用 for-await 消费 lifecycle（与 openai.ts / anthropic.ts 同构）。
    const provider = async function* (): AsyncGenerator<Evt> {
      try {
        for await (const ev of lc.guard(source())) yield ev;
      } finally {
        counters.providerFinalized++;
      }
    };

    // 漏斗：用 raceIterate 消费 provider；收到 error 就 throw（= fallback.ts 的
    // `throw new NormalizedErrorCarrier(...)`）。改造前这里抛错后什么都没 return，
    // provider 生成器永远停在 yield 上。
    let abandoned = false;
    try {
      for await (const ev of raceIterate(provider())) {
        if (ev.type === "error") throw new Error("漏斗放弃这次尝试");
      }
    } catch {
      abandoned = true;
    }
    expect(abandoned).toBe(true);

    // 让微任务跑干：return() 是「发出但不 await」的（见 race-iterate.ts 文件头）。
    await tick(0);
    expect(counters.providerFinalized).toBe(1);
    expect(counters.lifecycleFinalized).toBe(1);

    const stallsAtAbandon = counters.stalls;
    // 等待明显超过 idle 阈值（120ms）与若干 stall 周期（25ms）。
    await tick(300);
    // ① finally 跑了 ⇒ stall interval 被 clearTimers 清掉，计数不再增长。
    expect(counters.stalls).toBe(stallsAtAbandon);
    // ② idle 定时器也被清掉 ⇒ 不会再有「放弃后 120ms 才开枪」的幽灵触发。
    expect(counters.timeouts).toBe(0);
    // ③ lifecycle 的 finally 里调了 cancelSource（消费方放弃 → 取消底层 I/O）。
    expect(counters.cancelCalled).toBe(1);
  });

  test("消费方主动 break：同样释放源头并取消底层 I/O", async () => {
    let finalized = 0;
    let cancelCalled = 0;
    const source = async function* (): AsyncGenerator<Evt> {
      try {
        yield { type: "a" };
        yield { type: "b" };
      } finally {
        finalized++;
      }
    };
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 10_000,
      label: "F1-TEST",
      cancelSource: () => cancelCalled++,
    });
    for await (const ev of lc.guard(source())) {
      if (ev.type === "a") break;
    }
    await tick(0);
    expect(finalized).toBe(1);
    expect(cancelCalled).toBe(1);
  });

  test("正常走完的流：finally 执行，但**不**调 cancelSource（已完成的请求不该被 abort）", async () => {
    let finalized = 0;
    let cancelCalled = 0;
    const source = async function* (): AsyncGenerator<Evt> {
      try {
        yield { type: "a" };
        yield { type: "b" };
      } finally {
        finalized++;
      }
    };
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 10_000,
      label: "F1-TEST",
      cancelSource: () => cancelCalled++,
    });
    const got: string[] = [];
    for await (const ev of lc.guard(source())) got.push(ev.type);
    expect(got).toEqual(["a", "b"]);
    expect(finalized).toBe(1);
    expect(cancelCalled).toBe(0);
  });
});

describe("F1 形态 A — 源头挂住时超时能真的打断 await", () => {
  test("源头永不 settle：超时以 StreamLifecycleTimeoutError 结束，cancelSource 恰好一次", async () => {
    let cancelCalled = 0;
    const source = async function* (): AsyncGenerator<Evt> {
      yield { type: "content_block_delta" };
      await new Promise(() => {}); // reader.read() 永不 settle
    };
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 100,
      label: "F1-TEST",
      cancelSource: () => cancelCalled++,
    });

    const startedAt = Date.now();
    let caught: unknown = null;
    try {
      for await (const _ev of lc.guard(source())) {
        /* 消费 */
      }
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - startedAt;

    // 改造前：超时只置 snapshot.timedOut，而标志只在两次迭代之间检查 ——
    // 源头不 settle 时循环出不来，这里会挂到 bun 的 5s 超时。
    expect(caught).toBeInstanceOf(StreamLifecycleTimeoutError);
    expect((caught as StreamLifecycleTimeoutError).layer).toBe("idle");
    expect((caught as StreamLifecycleTimeoutError).thresholdMs).toBe(100);
    expect(elapsed).toBeLessThan(600);
    expect(cancelCalled).toBe(1);
  });

  test("content_progress 层超时同样以带类型的错误结束（不是流正常结束）", async () => {
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 10_000, // idle 不触发，让 content 层先命中
      contentProgressTimeoutMs: 100,
      isContentProgress: (e) => e.type === "content_block_delta",
      label: "F1-TEST",
    });
    const source = async function* (): AsyncGenerator<Evt> {
      yield { type: "content_block_delta" };
      await new Promise(() => {});
    };
    let caught: unknown = null;
    try {
      for await (const _ev of lc.guard(source())) {
        /* 消费 */
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StreamLifecycleTimeoutError);
    expect((caught as StreamLifecycleTimeoutError).layer).toBe("content_progress");
  });

  test("StreamLifecycleTimeoutError 归一化为 transient / timeout（不新增族）", () => {
    const err = new StreamLifecycleTimeoutError("idle", 240_000);
    const normalized = normalizeThrown(err);
    expect(normalized.presetReason).toBe("timeout");
    const verdict = classifyFamily(normalized);
    expect(verdict.family).toBe("transient");
    expect(verdict.reason).toBe("timeout");
  });

  test("超时后 stall 告警立即停止（语义修正：死流的心跳间隔没有信息量）", async () => {
    let stallsAfterTimeout = 0;
    let timedOutAt: number | null = null;
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 80,
      stallWarnMs: 20,
      label: "F1-TEST",
      onTimeout: () => {
        timedOutAt = Date.now();
      },
      onTelemetry: (e: StreamTelemetrySignal) => {
        if (e.type === "stream_stall" && timedOutAt !== null) stallsAfterTimeout++;
      },
    });
    const source = async function* (): AsyncGenerator<Evt> {
      await new Promise(() => {});
    };
    try {
      for await (const _ev of lc.guard(source())) {
        /* 消费 */
      }
    } catch {
      /* 预期超时 */
    }
    await tick(200);
    // fireTimeout 里立刻 clearInterval(stallTimer)：超时之后一条 stall 都不该出现。
    expect(stallsAfterTimeout).toBe(0);
  });
});

describe("F1 ⑤ — 活跃 lifecycle 计数", () => {
  test("正常结束回到基线；流进行中 +1；放弃后也回到基线", async () => {
    const baseline = getActiveStreamLifecycleCount();

    // 正常完成
    const normalSrc = async function* (): AsyncGenerator<Evt> {
      yield { type: "a" };
    };
    const lc1 = createStreamLifecycle<Evt>({ idleTimeoutMs: 10_000, label: "F1-TEST" });
    for await (const _ev of lc1.guard(normalSrc())) {
      /* 消费 */
    }
    expect(getActiveStreamLifecycleCount()).toBe(baseline);

    // 消费方 break（放弃）
    const stalledSrc = async function* (): AsyncGenerator<Evt> {
      yield { type: "a" };
      await new Promise(() => {});
    };
    const lc2 = createStreamLifecycle<Evt>({ idleTimeoutMs: 10_000, label: "F1-TEST" });
    for await (const _ev of lc2.guard(stalledSrc())) {
      break;
    }
    await tick(0);
    expect(getActiveStreamLifecycleCount()).toBe(baseline);
  });

  test("流进行中计数 +1（泄漏判据的另一半：不是只有 0 才能被观测到）", async () => {
    const baseline = getActiveStreamLifecycleCount();
    let duringCount = -1;
    const src = async function* (): AsyncGenerator<Evt> {
      yield { type: "a" };
      duringCount = getActiveStreamLifecycleCount();
      yield { type: "b" };
    };
    const lc = createStreamLifecycle<Evt>({ idleTimeoutMs: 10_000, label: "F1-TEST" });
    for await (const _ev of lc.guard(src())) {
      /* 消费 */
    }
    expect(duringCount).toBe(baseline + 1);
    expect(getActiveStreamLifecycleCount()).toBe(baseline);
  });
});
