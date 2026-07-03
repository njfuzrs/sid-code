/**
 * T2：stream-guard content progress timeout（ping 不续命）— 单元测试
 *
 * 验证 Anthropic keep-alive ping 场景的核心修复：
 *   - idle timer 对任何事件（含 ping）都 reset → 只发 ping 的流不会触发 idle timeout；
 *   - content progress timer 只对"业务进展"事件（content_block_delta / message_delta）reset
 *     → 只发 ping 的流会在 contentProgressTimeoutMs 后被识破并中断。
 *
 * 关键点：用极短阈值 + 高频 ping 制造"idle 永续命、content 无进展"的僵死流指纹。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { guardedStream } from "../../src/llm/stream-guard.ts";
import type { StreamGuardTelemetryEvent } from "../../src/llm/stream-guard.ts";

interface AnthropicLikeEvent {
  type: string;
}

/**
 * 制造一个"只发 ping、永不发业务内容"的流。
 * 每 intervalMs 发一个 ping，共发 count 个，然后自然结束（模拟连接被识破前的行为）。
 */
async function* pingOnlyStream(intervalMs: number, count: number): AsyncIterable<AnthropicLikeEvent> {
  for (let i = 0; i < count; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    yield { type: "ping" };
  }
}

/** 正常流：message_start → 多个 content_block_delta → message_delta → message_stop */
async function* normalStream(intervalMs: number): AsyncIterable<AnthropicLikeEvent> {
  yield { type: "message_start" };
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    yield { type: "content_block_delta" };
  }
  yield { type: "message_delta" };
  yield { type: "message_stop" };
}

const isAnthropicContent = (e: AnthropicLikeEvent) =>
  e.type === "content_block_delta" || e.type === "message_delta";

describe("T2 — content progress timeout（ping 不续命）", () => {
  test("只发 ping 的流：idle 不触发（被 ping reset），content progress 超时触发中断", async () => {
    const telemetry: StreamGuardTelemetryEvent[] = [];
    let timeoutLayer: string | undefined;

    // ping 每 20ms 一个（远小于 idle 的 200ms）→ idle 永远被 reset 不触发。
    // content progress 阈值 100ms → ping 不重置它 → 100ms 后触发。
    const guarded = guardedStream(pingOnlyStream(20, 100), {
      idleTimeoutMs: 200,
      contentProgressTimeoutMs: 100,
      isContentProgress: isAnthropicContent,
      stallWarnMs: 10_000, // 避免 stall 噪音干扰断言
      label: "TEST",
      onTimeout: (layer) => { timeoutLayer = layer; },
      onTelemetry: (evt) => { telemetry.push(evt); },
    });

    const received: AnthropicLikeEvent[] = [];
    for await (const ev of guarded) {
      received.push(ev);
    }

    // content progress timer 先触发（而非 idle）
    expect(timeoutLayer).toBe("content_progress");
    // 发出了 content progress timeout 遥测，且没有 idle timeout 遥测
    expect(telemetry.some((e) => e.type === "stream_content_progress_timeout")).toBe(true);
    expect(telemetry.some((e) => e.type === "stream_idle_timeout")).toBe(false);
    // 中断后流提前结束：收到的 ping 数远少于 100（阈值 100ms / 间隔 20ms ≈ 5 个后中断）
    expect(received.length).toBeLessThan(100);
  }, 15_000);

  test("正常流（有 content_block_delta）：content progress 不误伤，正常走完", async () => {
    const telemetry: StreamGuardTelemetryEvent[] = [];
    let timeoutFired = false;

    // 每个 content_block_delta 间隔 30ms，content progress 阈值 100ms → 每次都被 reset，不触发。
    const guarded = guardedStream(normalStream(30), {
      idleTimeoutMs: 500,
      contentProgressTimeoutMs: 100,
      isContentProgress: isAnthropicContent,
      stallWarnMs: 10_000,
      label: "TEST",
      onTimeout: () => { timeoutFired = true; },
      onTelemetry: (evt) => { telemetry.push(evt); },
    });

    const received: AnthropicLikeEvent[] = [];
    for await (const ev of guarded) {
      received.push(ev);
    }

    // 无任何超时触发
    expect(timeoutFired).toBe(false);
    expect(telemetry.some((e) => e.type === "stream_content_progress_timeout")).toBe(false);
    expect(telemetry.some((e) => e.type === "stream_idle_timeout")).toBe(false);
    // 完整收到全部事件：message_start + 5 delta + message_delta + message_stop = 8
    expect(received.length).toBe(8);
    // 正常完成事件
    expect(telemetry.some((e) => e.type === "stream_completed")).toBe(true);
  }, 15_000);

  test("不传 contentProgressTimeoutMs 时向后兼容：只有 idle timeout 生效", async () => {
    const telemetry: StreamGuardTelemetryEvent[] = [];

    // 只发 1 个 ping 后 stall（间隔 500ms），idle 阈值 100ms → idle 触发。
    async function* oneThenStall(): AsyncIterable<AnthropicLikeEvent> {
      yield { type: "ping" };
      await new Promise((r) => setTimeout(r, 500));
      yield { type: "ping" };
    }

    const guarded = guardedStream(oneThenStall(), {
      idleTimeoutMs: 100,
      // 不传 contentProgressTimeoutMs / isContentProgress → 该层空转
      stallWarnMs: 10_000,
      label: "TEST",
      onTelemetry: (evt) => { telemetry.push(evt); },
    });

    const received: AnthropicLikeEvent[] = [];
    for await (const ev of guarded) {
      received.push(ev);
    }

    // idle timeout 触发（100ms 无事件），无 content progress timeout
    expect(telemetry.some((e) => e.type === "stream_idle_timeout")).toBe(true);
    expect(telemetry.some((e) => e.type === "stream_content_progress_timeout")).toBe(false);
  }, 15_000);
});
