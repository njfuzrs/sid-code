/**
 * 子代理 agent/stream-processor 不自带任何超时层 — 单元测试
 *
 * 历史：T4 曾给这里补 idle 60s / overall 180s / 首字节闸门，本文件原先锁的就是它们开火。
 * 2026-10-17 整层删除：那层到点只置标志、连接不断（`getAbortController` 生产零调用方），
 * 等漏斗真正断流并重试时，把重试流判死（事故 20261016-224545，3 个子代理在 attempt=1
 * 后 4–8ms 判 error）。卡死现在**只**由漏斗负责（断流 + 重试），与主循环同构。
 *
 * 本文件改为锁住相反的事实（补清单，不删断言）：
 *   1. 发 1 chunk 后长静默 → processStream 不判超时、不 abort 上游，等事件来就继续消费；
 *   2. 持续出字的长流 → 不被整体时长截断；
 *   3. 慢首字节 → 不被截断；
 *   4. 正常流 / 旧签名照常工作；外层 signal 仍能穿透（ESC / 父代理取消）。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/agent/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 发一个 chunk 后静默 silentMs，再正常收尾 */
async function* stallThenResume(silentMs: number): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } as any;
  await sleep(silentMs);
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 2 },
  } as any;
}

/** 持续出字 totalMs 后收尾 */
async function* keepEmitting(totalMs: number): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "." },
    } as any;
    await sleep(15);
  }
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 2 },
  } as any;
}

/** 静默 silentMs 后才吐首个事件 */
async function* slowFirstByte(silentMs: number): AsyncIterable<StreamEvent> {
  await sleep(silentMs);
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 1 },
  } as any;
}

/** 正常快速完成的流 */
async function* normalStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 3, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "你好" },
  } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 2 },
  } as any;
}

/** 旧签名里的超时字段（已无读者）。传进去必须不生效——这正是变异自证的抓手。 */
const LEGACY_TIMEOUTS = {
  heartbeatTimeoutMs: 30,
  firstByteTimeoutMs: 30,
  overallTimeoutMs: 60,
  getAbortController: () => null,
} as never;

const textOf = (r: Awaited<ReturnType<typeof processStream>>) =>
  r.content.map((b) => (b.type === "text" ? b.text : "")).join("");

describe("子代理 processStream 不自行判超时", () => {
  test("发 1 chunk 后静默远超旧心跳阈值 → 不判死，恢复后继续消费", async () => {
    const turnAbort = new AbortController();
    const result = await processStream(stallThenResume(200), {
      ...(LEGACY_TIMEOUTS as object),
      signal: turnAbort.signal,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.errorMessage).toBeUndefined();
    expect(turnAbort.signal.aborted).toBe(false);
    expect(textOf(result)).toBe("hi!");
  });

  test("持续出字、总时长远超旧整体阈值 → 不截断", async () => {
    const result = await processStream(keepEmitting(200), LEGACY_TIMEOUTS);
    expect(result.stopReason).toBe("end_turn");
    expect(result.errorMessage).toBeUndefined();
  });

  test("慢首字节远超旧首字节阈值 → 不截断", async () => {
    const result = await processStream(slowFirstByte(200), LEGACY_TIMEOUTS);
    expect(result.stopReason).toBe("end_turn");
  });

  test("正常快速完成的流", async () => {
    const result = await processStream(normalStream(), {});
    expect(result.stopReason).toBe("end_turn");
    expect(textOf(result)).toBe("你好");
  });

  test("向后兼容：第二参传 AbortSignal（旧签名）仍工作", async () => {
    const ctl = new AbortController();
    const result = await processStream(normalStream(), ctl.signal);
    expect(result.stopReason).toBe("end_turn");
  });

  test("外层 signal 已 abort → 下一个事件处返回 Request aborted（ESC / 父代理取消穿透）", async () => {
    const ctl = new AbortController();
    async function* abortMidway(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        message: { usage: { inputTokens: 1, outputTokens: 0 } },
      } as any;
      ctl.abort();
      yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
    }
    const result = await processStream(abortMidway(), { signal: ctl.signal });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Request aborted");
  });
});
