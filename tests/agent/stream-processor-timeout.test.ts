/**
 * T4：子代理 stream-processor 心跳 + 整体超时 — 单元测试
 *
 * 验证 agent/stream-processor.ts 补齐的 setInterval 心跳（默认 60s）+ 整体超时
 * （默认 180s）。用可配置的短超时快速触发三种场景：
 *   1. 流发 1 个 chunk 后 stall → 心跳超时触发 → abort 上游 + 返回 error
 *   2. 流持续发送但超过整体超时 → 整体超时触发
 *   3. 正常快速完成的流 → 不触发任何超时
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/agent/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

/** 发一个 text chunk 后永久 stall（不再发事件、也不结束） */
async function* stallAfterOneChunk(signal: AbortSignal): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } as any;
  // 永久 stall，直到 signal abort 才退出（模拟半开 TCP）
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** 持续发事件（每次都刷新心跳），但整体跑很久，用于触发整体超时 */
async function* keepEmitting(signal: AbortSignal): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  while (!signal.aborted) {
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } } as any;
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** 正常快速完成的流 */
async function* normalStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 3, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 2 } } as any;
}

describe("T4 — 子代理 stream-processor 心跳 + 整体超时", () => {
  test("场景1：发 1 chunk 后 stall → 心跳超时触发，abort 上游并返回 error", async () => {
    const turnAbort = new AbortController();
    const result = await processStream(stallAfterOneChunk(turnAbort.signal), {
      signal: turnAbort.signal,
      getAbortController: () => turnAbort,
      heartbeatTimeoutMs: 60,
      overallTimeoutMs: 5_000,
      heartbeatCheckIntervalMs: 20,
    });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("heartbeat timeout");
    // 上游被主动 abort（心跳超时时 getAbortController().abort()）
    expect(turnAbort.signal.aborted).toBe(true);
    // stall 前累积的内容仍保留
    expect(result.content.some((b) => b.type === "text")).toBe(true);
  });

  test("场景2：持续发送但超过整体超时 → 整体超时触发", async () => {
    const turnAbort = new AbortController();
    const result = await processStream(keepEmitting(turnAbort.signal), {
      signal: turnAbort.signal,
      getAbortController: () => turnAbort,
      heartbeatTimeoutMs: 5_000, // 心跳不触发（一直有事件）
      overallTimeoutMs: 80,
      heartbeatCheckIntervalMs: 20,
    });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("overall timeout");
    expect(turnAbort.signal.aborted).toBe(true);
  });

  test("场景3：正常快速完成的流 → 不触发任何超时", async () => {
    const turnAbort = new AbortController();
    const result = await processStream(normalStream(), {
      signal: turnAbort.signal,
      getAbortController: () => turnAbort,
      heartbeatTimeoutMs: 60,
      overallTimeoutMs: 180,
      heartbeatCheckIntervalMs: 20,
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.errorMessage).toBeUndefined();
    expect(turnAbort.signal.aborted).toBe(false);
    const text = result.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(text).toBe("你好");
  });

  test("向后兼容：第二参传 AbortSignal（旧签名）仍工作", async () => {
    const ctl = new AbortController();
    const result = await processStream(normalStream(), ctl.signal);
    expect(result.stopReason).toBe("end_turn");
  });
});

/**
 * 回归（2026-08-05 事故，主循环侧同型缺陷的子代理镜像）：
 * 「等首个事件」这段等待必须用**首字节阈值**判定，不能被（更短的）心跳阈值误杀。
 *
 * 缺陷成因：lifecycle 的 idle timer 在 `resetIdle()` 首次调用时就已启动，因此首字节
 * 等待也被 idleTimeoutMs 管着；而子代理 idle 档默认仅 60s（BASE*0.2）。经网关转发时
 * 首字节要经历鉴权 + 排队 + 模型冷启动，实测可达 50-60s——正好压在阈值上，稍慢即被
 * 自己杀掉，重试又重新排队再次撞线，形成用户看到的「不停重试、永不结束」。
 */
describe("回归：子代理首字节等待不被心跳阈值误杀", () => {
  /** 静默 silentMs 后才吐首个事件，随后正常收尾 */
  function slowFirstByte(silentMs: number): AsyncIterable<StreamEvent> {
    const evs: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any,
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } } as any,
    ];
    let i = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (i === 0) await new Promise((r) => setTimeout(r, silentMs));
            if (i >= evs.length) return { done: true, value: undefined as any };
            return { done: false, value: evs[i++]! };
          },
        };
      },
    };
  }

  test("首字节慢于心跳阈值、但快于首字节阈值 → 不得中断", async () => {
    const turnAbort = new AbortController();
    // 静默 400ms > 心跳 150ms，但 < 首字节 5000ms。修复前必被判 error。
    const result = await processStream(slowFirstByte(400), {
      signal: turnAbort.signal,
      getAbortController: () => turnAbort,
      heartbeatTimeoutMs: 150,
      firstByteTimeoutMs: 5_000,
      overallTimeoutMs: 60_000,
    });

    expect(result.stopReason).toBe("end_turn");
    expect(turnAbort.signal.aborted).toBe(false);
  }, 15_000);

  test("首字节超过首字节阈值 → 仍须中断（闸门不能被放宽成永不生效）", async () => {
    const turnAbort = new AbortController();
    const result = await processStream(slowFirstByte(10_000), {
      signal: turnAbort.signal,
      getAbortController: () => turnAbort,
      heartbeatTimeoutMs: 10_000,
      firstByteTimeoutMs: 100, // 很短 → 必须触发
      overallTimeoutMs: 60_000,
    });

    expect(result.stopReason).toBe("error");
    expect(turnAbort.signal.aborted).toBe(true);
  }, 15_000);
});
