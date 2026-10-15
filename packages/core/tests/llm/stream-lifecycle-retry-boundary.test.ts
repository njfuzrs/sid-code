/**
 * StreamLifecycle × 漏斗控制事件（retry_backoff / stream_restart / system_api_error）。
 *
 * 事故 20261015-114502-c596be23：子代理 lifecycle 包的是整个漏斗，三层计时把重试退避也算进去，
 * overall 180s 在第 6 次退避中途开枪。本文件钉住 lifecycle 层的计时语义：
 *   1. 退避期三层（idle / content / overall）全部停表；
 *   2. 新尝试（retry_backoff end / stream_restart）三层重新起表，idle 回到首字节档；
 *   3. 控制事件不算活动、不计 totalEvents、不触发 TTFT；
 *   4. 负向对照：没有控制事件的流（provider 内部用法）overall 仍是整条流的绝对上限。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import {
  createStreamLifecycle,
  classifyRetryBoundary,
  type StreamTimeoutLayer,
} from "@sid-code/core/llm/stream-lifecycle.ts";

type Evt = { type: string; phase?: string; delayMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isContent = (e: Evt) => e.type === "content_block_delta" || e.type === "message_delta";
const backoffStart = (delayMs: number): Evt => ({ type: "retry_backoff", phase: "start", delayMs });
const backoffEnd = (delayMs: number): Evt => ({ type: "retry_backoff", phase: "end", delayMs });

async function drain(
  source: AsyncIterable<Evt>,
  opts: { idle?: number; firstByte?: number; content?: number; overall?: number } = {},
) {
  const fired: StreamTimeoutLayer[] = [];
  let ttftCalls = 0;
  const lc = createStreamLifecycle<Evt>({
    idleTimeoutMs: opts.idle ?? 5_000,
    firstByteTimeoutMs: opts.firstByte,
    contentProgressTimeoutMs: opts.content,
    overallTimeoutMs: opts.overall,
    isContentProgress: isContent,
    stallWarnMs: 60_000,
    label: "TEST",
    onTimeout: (l) => fired.push(l),
    onFirstContentProgress: () => {
      ttftCalls++;
    },
  });
  const received: Evt[] = [];
  for await (const e of lc.guard(source)) received.push(e);
  return { fired, received, snapshot: lc.getSnapshot(), ttftCalls };
}

describe("classifyRetryBoundary", () => {
  test("三种控制事件 → 对应动作；其余事件 → null", () => {
    expect(classifyRetryBoundary(backoffStart(1))).toBe("backoff_start");
    expect(classifyRetryBoundary(backoffEnd(1))).toBe("attempt_start");
    expect(classifyRetryBoundary({ type: "stream_restart", reason: "rate_limit" })).toBe(
      "attempt_start",
    );
    expect(classifyRetryBoundary({ type: "system_api_error" })).toBe("ignore");
    expect(classifyRetryBoundary({ type: "content_block_delta" })).toBeNull();
    expect(classifyRetryBoundary({ type: "ping" })).toBeNull();
    expect(classifyRetryBoundary(null)).toBeNull();
    expect(classifyRetryBoundary("retry_backoff")).toBeNull();
  });
});

describe("退避期停表", () => {
  test("overall：退避 300ms > overall 150ms，两次尝试各自 < 150ms → 不开枪", async () => {
    async function* src(): AsyncIterable<Evt> {
      yield { type: "error" };
      yield backoffStart(300);
      await sleep(300);
      yield backoffEnd(300);
      yield { type: "stream_restart" };
      await sleep(80);
      yield { type: "content_block_delta" };
      yield { type: "message_delta" };
    }
    const { fired, received } = await drain(src(), { overall: 150 });
    expect(fired).toEqual([]);
    expect(received.at(-1)?.type).toBe("message_delta");
  });

  test("idle：退避 300ms > idle 100ms → 不开枪", async () => {
    async function* src(): AsyncIterable<Evt> {
      yield { type: "content_block_delta" };
      yield backoffStart(300);
      await sleep(300);
      yield backoffEnd(300);
      yield { type: "content_block_delta" };
    }
    const { fired } = await drain(src(), { idle: 100 });
    expect(fired).toEqual([]);
  });

  test("content progress：退避 300ms > content 100ms → 不开枪", async () => {
    async function* src(): AsyncIterable<Evt> {
      yield { type: "content_block_delta" };
      yield backoffStart(300);
      await sleep(300);
      yield backoffEnd(300);
      yield { type: "content_block_delta" };
    }
    const { fired } = await drain(src(), { content: 100 });
    expect(fired).toEqual([]);
  });

  test("system_api_error（退避进度提示）不续命 idle：退避外的真静默照样开枪", async () => {
    async function* src(): AsyncIterable<Evt> {
      yield { type: "content_block_delta" };
      // 不在退避窗口内的 system_api_error 只是噪音，不能把它当活动
      for (let i = 0; i < 10; i++) {
        await sleep(30);
        yield { type: "system_api_error" };
      }
    }
    const { fired } = await drain(src(), { idle: 100 });
    expect(fired).toEqual(["idle"]);
  });
});

describe("新尝试重新起表", () => {
  test("overall 按尝试重置：两次尝试各 100ms（合计 > overall 150ms）→ 不开枪", async () => {
    async function* src(): AsyncIterable<Evt> {
      await sleep(100);
      yield { type: "error" };
      yield backoffStart(10);
      await sleep(10);
      yield backoffEnd(10);
      await sleep(100);
      yield { type: "content_block_delta" };
    }
    const { fired } = await drain(src(), { overall: 150 });
    expect(fired).toEqual([]);
  });

  test("stream_restart 单独出现（无退避，如休眠重开）也重置 overall", async () => {
    async function* src(): AsyncIterable<Evt> {
      yield { type: "content_block_delta" };
      await sleep(100);
      yield { type: "stream_restart" };
      await sleep(100);
      yield { type: "content_block_delta" };
    }
    const { fired } = await drain(src(), { overall: 150, idle: 5_000 });
    expect(fired).toEqual([]);
  });

  test("idle 回到首字节档：新尝试等首字节 200ms（> idle 100ms、< firstByte 500ms）→ 不开枪", async () => {
    async function* src(): AsyncIterable<Evt> {
      yield { type: "content_block_delta" }; // 第一次尝试已收到首字节 → 切到 idle 档
      yield backoffStart(10);
      await sleep(10);
      yield backoffEnd(10);
      await sleep(200); // 新尝试在排队
      yield { type: "content_block_delta" };
    }
    const { fired } = await drain(src(), { idle: 100, firstByte: 500 });
    expect(fired).toEqual([]);
  });

  test("负向对照：新尝试的单次耗时本身超 overall → 照样开枪", async () => {
    const upstream = new AbortController();
    async function* src(): AsyncIterable<Evt> {
      yield { type: "error" };
      yield backoffStart(10);
      await sleep(10);
      yield backoffEnd(10);
      while (!upstream.signal.aborted) {
        await sleep(20);
        yield { type: "content_block_delta" };
      }
    }
    const lcFired: StreamTimeoutLayer[] = [];
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 5_000,
      overallTimeoutMs: 150,
      isContentProgress: isContent,
      label: "TEST",
      onTimeout: (l) => {
        lcFired.push(l);
        upstream.abort();
      },
    });
    for await (const _ of lc.guard(src())) {
      /* drain */
    }
    expect(lcFired).toEqual(["overall"]);
  });
});

describe("控制事件不污染观测口径", () => {
  test("不计 totalEvents、不触发 TTFT 回调，但原样透传给消费方", async () => {
    async function* src(): AsyncIterable<Evt> {
      yield backoffStart(5);
      await sleep(5);
      yield backoffEnd(5);
      yield { type: "system_api_error" };
      yield { type: "stream_restart" };
      yield { type: "content_block_delta" };
    }
    const { received, snapshot, ttftCalls } = await drain(src());
    expect(received.map((e) => e.type)).toEqual([
      "retry_backoff",
      "retry_backoff",
      "system_api_error",
      "stream_restart",
      "content_block_delta",
    ]);
    expect(snapshot.totalEvents).toBe(1);
    expect(ttftCalls).toBe(1);
  });
});

describe("负向对照：无控制事件的流（provider 内部用法）行为不变", () => {
  test("overall 仍是整条流的绝对上限", async () => {
    const upstream = new AbortController();
    async function* src(): AsyncIterable<Evt> {
      while (!upstream.signal.aborted) {
        await sleep(20);
        yield { type: "content_block_delta" };
      }
    }
    const fired: StreamTimeoutLayer[] = [];
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 5_000,
      overallTimeoutMs: 150,
      isContentProgress: isContent,
      label: "TEST",
      onTimeout: (l) => {
        fired.push(l);
        upstream.abort();
      },
    });
    const t0 = Date.now();
    for await (const _ of lc.guard(src())) {
      /* drain */
    }
    expect(fired).toEqual(["overall"]);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
