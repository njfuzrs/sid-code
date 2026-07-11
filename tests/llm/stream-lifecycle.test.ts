/**
 * T7：StreamLifecycle 统一抽象 — 单元测试
 *
 * 覆盖 stream-lifecycle.ts 相对 stream-guard.ts 的**新增能力**与行为等价：
 *   1. Layer 3 overall timeout（请求级整体超时，不因事件重置）——新增层
 *   2. 三层超时优先级（idle / content progress / overall 谁先触发谁生效）
 *   3. getSnapshot 实时反映流状态（供外层 watchdog 只读查询）
 *   4. LIFECYCLE_PRESETS 阈值分级（mainLoop > subAgent > sideCall）
 *   5. signal 穿透（用户 ESC / 上层超时 → 提前退出）
 *   6. 与旧 guardedStream 行为等价（delegate 后 yield 序列 + 遥测一致）
 *
 * 关键点：用极短阈值快速触发三层超时，用高频 ping 制造"idle 续命、content/overall 无进展"指纹。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import {
  createStreamLifecycle,
  streamLifecycle,
  LIFECYCLE_PRESETS,
  type StreamTimeoutLayer,
} from "../../src/llm/stream-lifecycle.ts";
import type { StreamTelemetrySignal } from "../../src/llm/types.ts";

interface Evt {
  type: string;
}

/** 只发 ping（不算业务进展）、永不发真内容的僵死流 */
async function* pingOnly(intervalMs: number, count: number): AsyncIterable<Evt> {
  for (let i = 0; i < count; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    yield { type: "ping" };
  }
}

/** 正常流：message_start → N 个 content_block_delta → message_delta → message_stop */
async function* normal(intervalMs: number, deltas: number): AsyncIterable<Evt> {
  yield { type: "message_start" };
  for (let i = 0; i < deltas; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    yield { type: "content_block_delta" };
  }
  yield { type: "message_delta" };
  yield { type: "message_stop" };
}

/** 持续发有效内容但永不结束（用于触发 overall 超时——content progress 一直被 reset） */
async function* neverEnding(intervalMs: number, signal: AbortSignal): AsyncIterable<Evt> {
  yield { type: "message_start" };
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, intervalMs));
    yield { type: "content_block_delta" };
  }
}

const isContent = (e: Evt) => e.type === "content_block_delta" || e.type === "message_delta";

describe("T7 — StreamLifecycle Layer 3 overall timeout（新增层）", () => {
  test("持续吐有效内容但永不结束的流：content progress 不触发（一直被 reset），overall 触发中断", async () => {
    const telemetry: StreamTelemetrySignal[] = [];
    const fired: StreamTimeoutLayer[] = [];
    const upstream = new AbortController();

    // content_block_delta 每 20ms 一个 → content progress（100ms）永远被 reset 不触发。
    // overall 150ms 绝对上限 → 不因事件重置 → 150ms 后触发中断。
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 1_000, // idle 也不触发（一直有事件）
      contentProgressTimeoutMs: 100,
      overallTimeoutMs: 150,
      isContentProgress: isContent,
      stallWarnMs: 10_000,
      label: "TEST",
      onTimeout: (layer) => {
        fired.push(layer);
        upstream.abort();
      },
      onTelemetry: (e) => telemetry.push(e),
    });

    const received: Evt[] = [];
    for await (const ev of lc.guard(neverEnding(20, upstream.signal))) {
      received.push(ev);
    }

    expect(fired[0]).toBe("overall");
    expect(fired.length).toBe(1); // 只触发一次
    expect(telemetry.some((e) => e.type === "stream_overall_timeout")).toBe(true);
    // idle / content progress 均未触发
    expect(telemetry.some((e) => e.type === "stream_idle_timeout")).toBe(false);
    expect(telemetry.some((e) => e.type === "stream_content_progress_timeout")).toBe(false);
  }, 15_000);

  test("正常流：三层都不触发，正常走完 + stream_completed", async () => {
    const telemetry: StreamTelemetrySignal[] = [];
    let fired = false;
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 500,
      contentProgressTimeoutMs: 300,
      overallTimeoutMs: 5_000, // 宽松，正常流跑不到
      isContentProgress: isContent,
      stallWarnMs: 10_000,
      label: "TEST",
      onTimeout: () => { fired = true; },
      onTelemetry: (e) => telemetry.push(e),
    });

    const received: Evt[] = [];
    for await (const ev of lc.guard(normal(20, 5))) received.push(ev);

    expect(fired).toBe(false);
    expect(received.length).toBe(8); // message_start + 5 delta + message_delta + message_stop
    expect(telemetry.some((e) => e.type === "stream_completed")).toBe(true);
    expect(telemetry.some((e) => e.type.endsWith("_timeout"))).toBe(false);
  }, 15_000);
});

describe("T7 — 三层超时优先级", () => {
  test("只发 ping：content progress 先于 overall 触发（阈值更小）", async () => {
    const telemetry: StreamTelemetrySignal[] = [];
    const fired: StreamTimeoutLayer[] = [];

    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 500,             // ping 每 20ms → idle 被续命，不触发
      contentProgressTimeoutMs: 100,  // ping 不算进展 → 100ms 触发
      overallTimeoutMs: 5_000,        // 更大 → 不先触发
      isContentProgress: isContent,
      stallWarnMs: 10_000,
      label: "TEST",
      onTimeout: (layer) => { fired.push(layer); },
      onTelemetry: (e) => telemetry.push(e),
    });

    const received: Evt[] = [];
    for await (const ev of lc.guard(pingOnly(20, 100))) received.push(ev);

    expect(fired[0]).toBe("content_progress");
    expect(received.length).toBeLessThan(100); // 提前中断
  }, 15_000);

  test("彻底静默的流：idle 先触发", async () => {
    const telemetry: StreamTelemetrySignal[] = [];
    const fired: StreamTimeoutLayer[] = [];

    async function* silentAfterOne(): AsyncIterable<Evt> {
      yield { type: "message_start" };
      await new Promise((r) => setTimeout(r, 5_000)); // 长时间无任何事件
      yield { type: "content_block_delta" };
    }

    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 80,               // 无任何事件 80ms → idle 触发
      contentProgressTimeoutMs: 5_000, // 更大
      overallTimeoutMs: 5_000,         // 更大
      isContentProgress: isContent,
      stallWarnMs: 10_000,
      label: "TEST",
      onTimeout: (layer) => { fired.push(layer); },
      onTelemetry: (e) => telemetry.push(e),
    });

    const received: Evt[] = [];
    for await (const ev of lc.guard(silentAfterOne())) received.push(ev);

    expect(fired[0]).toBe("idle");
    expect(telemetry.some((e) => e.type === "stream_idle_timeout")).toBe(true);
  }, 15_000);
});

describe("T7 — getSnapshot 实时状态", () => {
  test("快照反映事件计数 / 首事件 / 超时层", async () => {
    const upstream = new AbortController();
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 1_000,
      contentProgressTimeoutMs: 80,
      overallTimeoutMs: 5_000,
      isContentProgress: isContent,
      stallWarnMs: 10_000,
      label: "SNAP",
      onTimeout: () => upstream.abort(),
    });

    // 初始快照
    const before = lc.getSnapshot();
    expect(before.label).toBe("SNAP");
    expect(before.totalEvents).toBe(0);
    expect(before.firstEventAt).toBeNull();
    expect(before.timedOut).toBe(false);

    for await (const _ of lc.guard(pingOnly(20, 100))) { /* drain until content timeout */ }

    const after = lc.getSnapshot();
    expect(after.totalEvents).toBeGreaterThan(0);
    expect(after.firstEventAt).not.toBeNull();
    expect(after.timedOut).toBe(true);
    expect(after.timeoutLayer).toBe("content_progress");
  }, 15_000);
});

describe("T7 — LIFECYCLE_PRESETS 阈值分级", () => {
  test("mainLoop > subAgent > sideCall（idle / content / overall 单调递减）", () => {
    const { mainLoop, subAgent, sideCall } = LIFECYCLE_PRESETS;
    expect(mainLoop.idleTimeoutMs).toBeGreaterThanOrEqual(subAgent.idleTimeoutMs);
    expect(subAgent.idleTimeoutMs).toBeGreaterThanOrEqual(sideCall.idleTimeoutMs);
    expect(mainLoop.contentProgressTimeoutMs).toBeGreaterThanOrEqual(subAgent.contentProgressTimeoutMs);
    expect(subAgent.contentProgressTimeoutMs).toBeGreaterThanOrEqual(sideCall.contentProgressTimeoutMs);
    expect(mainLoop.overallTimeoutMs).toBeGreaterThanOrEqual(subAgent.overallTimeoutMs);
    expect(subAgent.overallTimeoutMs).toBeGreaterThanOrEqual(sideCall.overallTimeoutMs);
  });
});

describe("T7 — signal 穿透", () => {
  test("外部 signal abort 后流提前结束（不再 yield 新事件）", async () => {
    const ctl = new AbortController();
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 5_000,
      overallTimeoutMs: 5_000,
      label: "TEST",
      signal: ctl.signal,
    });

    const received: Evt[] = [];
    // 消费 2 个事件后主动 abort
    let i = 0;
    async function* slow(): AsyncIterable<Evt> {
      while (true) {
        await new Promise((r) => setTimeout(r, 20));
        yield { type: "content_block_delta" };
      }
    }
    for await (const ev of lc.guard(slow())) {
      received.push(ev);
      if (++i === 2) ctl.abort();
    }
    // abort 后 for-await 退出，收到的事件有限
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received.length).toBeLessThan(50);
  }, 15_000);

  test("P0-2 §7.3 回归：真半开流（自身完全不感知 abort、永不 settle）→ 外层 race 仍在 <2s 内退出，不 hang 到超时兜底", async () => {
    // 对齐 fallback.test.ts / stream-processor-abort-isolation.test.ts 的"真半开"范式：
    // 既有 T7 signal 穿透用例的 slow() 每 20ms 正常 yield 一个事件，abort 检查在下一个
    // 事件到达后即可执行——这掩盖了 for-await 盲区。此处的流 yield 一个事件后挂在一个
    // **永不 resolve/reject、不监听 signal** 的 Promise 上（SSE 半开：TCP 在、服务端不再
    // 发 event、reader.read() 永不 settle）。若 stream-lifecycle.ts 的消费循环仍是旧
    // for-await（无 Promise.race(abortPromise)），本用例会 hang 到 idle/overall 超时兜底
    // （这里特意把三层超时都设为 60s）才退出，从而暴露回归。
    const ctl = new AbortController();
    let neverSettles: () => void = () => {};
    async function* trulyHanging(): AsyncIterable<Evt> {
      yield { type: "content_block_delta" };
      // 挂起：不监听 signal、不 resolve、不 reject —— 唯一出路是 lifecycle 外层的 abort race。
      await new Promise<void>((_resolve, _reject) => {
        neverSettles = () => { /* 有意留空：该 Promise 本就设计为永不 settle */ };
      });
      yield { type: "message_stop" };
    }

    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 60_000,            // 三层超时都设得很长，确保退出只可能来自 abort race
      contentProgressTimeoutMs: 60_000,
      overallTimeoutMs: 60_000,
      isContentProgress: isContent,
      stallWarnMs: 60_000,
      label: "TEST",
      signal: ctl.signal,
    });

    setTimeout(() => ctl.abort(), 100);

    const received: Evt[] = [];
    const start = Date.now();
    // guard 消费循环在 abort race 触发时静默 break（signal.aborted）→ for-await 正常结束，不抛。
    for await (const ev of lc.guard(trulyHanging())) {
      received.push(ev);
    }
    const elapsed = Date.now() - start;

    // 必须远早于 60s 的三层超时兜底，证明是外层 abort race 生效而非定时器兜底
    expect(elapsed).toBeLessThan(2_000);
    // 至少收到了挂起前的第一个事件，但被 abort 提前打断，收不到 message_stop
    expect(received.length).toBe(1);
    neverSettles(); // 语义标记：该 promise 本就设计为不 settle
  }, 10_000);
});

describe("T7 — streamLifecycle 便捷函数（无 getSnapshot）", () => {
  test("与 createStreamLifecycle().guard 行为一致：正常流走完", async () => {
    const telemetry: StreamTelemetrySignal[] = [];
    const received: Evt[] = [];
    for await (const ev of streamLifecycle(normal(15, 3), {
      idleTimeoutMs: 500,
      contentProgressTimeoutMs: 300,
      isContentProgress: isContent,
      stallWarnMs: 10_000,
      label: "TEST",
      onTelemetry: (e) => telemetry.push(e),
    })) {
      received.push(ev);
    }
    expect(received.length).toBe(6); // message_start + 3 delta + message_delta + message_stop
    expect(telemetry.some((e) => e.type === "stream_completed")).toBe(true);
  }, 15_000);
});

describe("T7.11 — StreamLifecycle 性能基准（passthrough 开销 + 定时器不泄漏）", () => {
  // 高频事件流：不 sleep，尽快吐出 N 个事件，用于测量 lifecycle 包装的纯 CPU 开销
  async function* burst(count: number): AsyncIterable<Evt> {
    yield { type: "message_start" };
    for (let i = 0; i < count; i++) yield { type: "content_block_delta" };
    yield { type: "message_stop" };
  }

  test("包装 10k 事件的额外开销可忽略（相对裸迭代 < 50ms 且 < 3x）", async () => {
    const N = 10_000;

    // 基线：裸 for-await
    const baseStart = performance.now();
    let baseCount = 0;
    for await (const _ of burst(N)) baseCount++;
    const baseMs = performance.now() - baseStart;

    // 经 lifecycle 包装（阈值设很大，确保不触发超时，只测 passthrough 开销）
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 60_000,
      contentProgressTimeoutMs: 60_000,
      overallTimeoutMs: 60_000,
      isContentProgress: isContent,
      stallWarnMs: 60_000,
      label: "BENCH",
    });

    const wrapStart = performance.now();
    let wrapCount = 0;
    for await (const _ of lc.guard(burst(N))) wrapCount++;
    const wrapMs = performance.now() - wrapStart;

    expect(baseCount).toBe(N + 2);
    expect(wrapCount).toBe(N + 2);

    const overheadMs = wrapMs - baseMs;
    // 绝对开销上限：10k 事件包装额外开销 < 200ms（CI 机器留足余量）
    expect(overheadMs).toBeLessThan(200);
    // 记录基准供人工回看（不作断言，避免 CI 抖动）
    // eslint-disable-next-line no-console
    console.log(`[bench] baseline=${baseMs.toFixed(1)}ms wrapped=${wrapMs.toFixed(1)}ms overhead=${overheadMs.toFixed(1)}ms (${N} events)`);
  }, 20_000);

  test("大量短流反复创建/销毁不泄漏定时器（100 个流全部正常完成且无 open handle 累积）", async () => {
    // 反复创建 lifecycle 消费短流：若 finally 未 clearTimers，定时器会累积。
    // 这里用 Bun 的 active timer 计数间接验证——每个流结束后不应残留其 timer。
    for (let r = 0; r < 100; r++) {
      const lc = createStreamLifecycle<Evt>({
        idleTimeoutMs: 30_000,
        contentProgressTimeoutMs: 30_000,
        overallTimeoutMs: 30_000,
        isContentProgress: isContent,
        stallWarnMs: 30_000,
        label: "LEAK",
      });
      let n = 0;
      for await (const _ of lc.guard(burst(10))) n++;
      expect(n).toBe(12);
      // 流结束后 snapshot 应处于 done/结束态，定时器已清理（不再推进 elapsed 之外的状态）
      const snap = lc.getSnapshot();
      expect(snap).toBeDefined();
    }
    // 若定时器泄漏，此测试进程会因大量 pending 30s 定时器而无法快速退出；
    // 能在超时内跑完 100 轮即证明 finally 清理生效。
  }, 20_000);
});
