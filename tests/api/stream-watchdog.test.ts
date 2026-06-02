/**
 * stream-watchdog.ts 测试
 * 停滞检测 / 超时告警 / TTFB / 指标采集
 */

import { describe, test, expect } from "bun:test";
import { withWatchdog, meteredStream, type StreamMetrics } from "../../src/api/stream-watchdog.ts";

/** 一个由手动推进的事件流，便于注入时间 */
async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) yield it;
}

describe("meteredStream", () => {
  test("采集 TTFB / 事件数 / lastEventType", async () => {
    let t = 1000;
    const now = () => t;
    const events = [
      { type: "message_start" },
      { type: "content_block_delta" },
      { type: "message_stop" },
    ];
    // 用一个生成器在每次 yield 后推进时间
    async function* timed() {
      t = 1000;
      yield events[0];
      t = 1100; // 首事件后 100ms
      yield events[1];
      t = 1150;
      yield events[2];
    }
    const { stream, getMetrics } = meteredStream(timed(), now);
    const collected: any[] = [];
    for await (const e of stream) collected.push(e);
    const m = getMetrics();
    expect(collected.length).toBe(3);
    expect(m.eventCount).toBe(3);
    expect(m.ttfbMs).toBe(0); // 首事件在 t=1000，与 start 同时
    expect(m.lastEventType).toBe("message_stop");
  });

  test("停滞检测：超过 30s 间隔计为一次停滞", async () => {
    let t = 0;
    async function* timed() {
      t = 0;
      yield { type: "a" };
      t = 40_000; // 40s 间隔 > 30s 阈值
      yield { type: "b" };
    }
    const { stream, getMetrics } = meteredStream(timed(), () => t);
    for await (const _ of stream) { /* drain */ }
    const m = getMetrics();
    expect(m.stallCount).toBe(1);
    expect(m.totalStallTimeMs).toBe(40_000);
  });

  test("无事件时 ttfb 为 -1", async () => {
    const { stream, getMetrics } = meteredStream(fromArray([]), () => 0);
    for await (const _ of stream) { /* drain */ }
    expect(getMetrics().ttfbMs).toBe(-1);
  });
});

describe("withWatchdog", () => {
  test("透传所有事件", async () => {
    const events = [{ type: "x" }, { type: "y" }];
    const out: any[] = [];
    for await (const e of withWatchdog(fromArray(events), { checkIntervalMs: 999999 })) {
      out.push(e);
    }
    expect(out).toEqual(events);
  });

  test("空闲超时触发 onTimeout 回调", async () => {
    let fired = false;
    let warned = false;
    // 一个永远不结束、但也不产出事件的流，用短超时 + 真实定时器
    async function* idle() {
      await new Promise((r) => setTimeout(r, 200));
      yield { type: "late" };
    }
    const metrics: StreamMetrics[] = [];
    for await (const _ of withWatchdog(idle(), {
      idleTimeoutMs: 50,
      checkIntervalMs: 20,
      onWarning: () => { warned = true; },
      onTimeout: (m) => { fired = true; metrics.push(m); },
    })) { /* drain */ }
    expect(warned).toBe(true);
    expect(fired).toBe(true);
  });

  test("signal abort 后停止迭代", async () => {
    const ctrl = new AbortController();
    async function* many() {
      for (let i = 0; i < 100; i++) {
        if (i === 2) ctrl.abort();
        yield { type: "e", i };
      }
    }
    const out: any[] = [];
    for await (const e of withWatchdog(many(), { checkIntervalMs: 999999 }, ctrl.signal)) {
      out.push(e);
    }
    // abort 在 i=2 时触发，下一轮循环 break
    expect(out.length).toBeLessThanOrEqual(3);
  });
});
