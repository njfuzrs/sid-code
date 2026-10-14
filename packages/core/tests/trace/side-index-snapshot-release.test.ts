/**
 * 回归 · 影子调用（900_000+ 号段）的流快照必须在流结束时释放
 *
 * 实测会话 20261013-124000-9c3eb216：空闲 36 分钟后 heartbeat.txt 仍报
 * `active_request: {index: 900002, phase: "first_content", chunks: 27, active_count: 3}`——
 * 一条早已收完的轮后 fork 流被心跳当成「卡住的在途请求」。
 *
 * 三条清理路径都够不着这把 key（见 stream-observer.ts `clearSnapshotsForIndex` 注释），
 * 修复是让 `streamWithResilience` 在自己分配的 index 上收尾时清。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initStreamObserver,
  resetStreamObserver,
  emitStreamPhase,
  getActiveStreamSnapshots,
  clearSnapshotsForIndex,
} from "@sid-code/core/trace/stream-observer.ts";
import { streamWithResilience } from "@sid-code/core/llm/resilient-stream.ts";
import { currentSseDumpContext } from "@sid-code/core/llm/sse-chunk-dumper.ts";

beforeEach(() => initStreamObserver("s", "/tmp", () => {}));
afterEach(() => resetStreamObserver());

describe("clearSnapshotsForIndex", () => {
  test("只清指定 index，跨 loopId / agentId 都清；不误伤其它 index", () => {
    emitStreamPhase(900_123, "first_content", { model: "m" });
    emitStreamPhase(900_123, "first_content", { model: "m" }, "fork:a:1");
    emitStreamPhase(7, "first_content", { model: "m" });
    expect(getActiveStreamSnapshots().length).toBe(3);
    clearSnapshotsForIndex(900_123);
    const left = getActiveStreamSnapshots();
    expect(left.length).toBe(1);
    expect(left[0].index).toBe(7);
  });
});

describe("streamWithResilience 释放自分配的影子 index", () => {
  function fakeProvider(): any {
    return {
      name: () => "anthropic",
      async *sendMessageStream() {
        // 模拟 anthropic 路径：只 emit first_content，永不 emit completed
        emitStreamPhase(currentSseDumpContext().turnIndex, "first_content", { model: "m" });
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        yield { type: "message_stop" };
      },
    };
  }

  test("流正常结束后不残留快照", async () => {
    const gen = streamWithResilience(
      fakeProvider(),
      { model: "m", messages: [] } as any,
      undefined,
      {
        querySource: "test" as any,
        maxRetries: 0,
      } as any,
    );
    for await (const _ of gen) {
      /* drain */
    }
    expect(getActiveStreamSnapshots().filter((s) => s.index >= 900_000)).toEqual([]);
  });

  test("消费方提前 break 也释放", async () => {
    const gen = streamWithResilience(
      fakeProvider(),
      { model: "m", messages: [] } as any,
      undefined,
      {
        querySource: "test" as any,
        maxRetries: 0,
      } as any,
    );
    for await (const _ of gen) break;
    expect(getActiveStreamSnapshots().filter((s) => s.index >= 900_000)).toEqual([]);
  });

  test("调用方自带 observerIndex 时不越权清理（由调用方自己的收尾负责）", async () => {
    const gen = streamWithResilience(
      fakeProvider(),
      { model: "m", messages: [] } as any,
      undefined,
      {
        querySource: "test" as any,
        maxRetries: 0,
        observerIndex: 10_001,
      } as any,
    );
    for await (const _ of gen) {
      /* drain */
    }
    expect(getActiveStreamSnapshots().some((s) => s.index === 10_001)).toBe(true);
  });
});
