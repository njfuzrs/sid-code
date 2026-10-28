/**
 * #6（2026-10-27）：系统休眠不得被 stream-processor 记成「首字节超时」。
 *
 * bug2mr P2 三个会话醒来那一刻同时出现「检测到系统休眠 975s … 重开（不计重试次数）」
 * 「首字节超时: 300s 无数据」「流式超时，重试 1/10」三行，归因与计数自相矛盾。
 *
 * 用挂钟跳变模拟休眠：真实时间只过几十毫秒，Date.now 一次性前跳 1000s。
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

function delayedStream(silentMs: number): AsyncIterable<StreamEvent> {
  const events: StreamEvent[] = [
    { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any,
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } as any,
    { type: "content_block_stop", index: 0 } as any,
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 1 },
    } as any,
  ];
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (i === 0) await new Promise((r) => setTimeout(r, silentMs));
          if (i >= events.length) return { done: true, value: undefined as any };
          return { done: false, value: events[i++]! };
        },
      };
    },
  };
}

describe("#6：休眠不算静默", () => {
  test("等首字节期间挂钟前跳 1000s → 不触发首字节超时，正常完成", async () => {
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    const jump = setTimeout(() => {
      offset = 1_000_000;
    }, 50);
    const turnController = new AbortController();
    try {
      const resp = await processStream(delayedStream(200), undefined, undefined, {
        heartbeatTimeoutMs: 5_000,
        firstByteTimeoutMs: 400,
        overallTimeoutMs: 5_000,
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
      expect(resp.stopReason).toBe("end_turn");
      expect(turnController.signal.aborted).toBe(false);
    } finally {
      clearTimeout(jump);
      Date.now = realNow;
    }
  }, 15_000);

  test("真实静默超过首字节阈值仍须中断（不把闸门放宽成永不生效）", async () => {
    const turnController = new AbortController();
    let thrown: unknown = null;
    try {
      await processStream(delayedStream(5_000), undefined, undefined, {
        heartbeatTimeoutMs: 5_000,
        firstByteTimeoutMs: 60,
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(turnController.signal.reason).toBe("stream-heartbeat-timeout");
  }, 15_000);
});
