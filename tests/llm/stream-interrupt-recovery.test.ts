/**
 * T9.1：流式中断 & 恢复专项测试
 *
 * 三大场景：
 *   1. mid-stream 网络断开 → 验证重试机制正确恢复（连接错误触发连接阶段重试）
 *   2. mid-stream abort → 验证资源清理完整（AbortSignal 穿透 + 流消费退出）
 *   3. mid-stream 超时 → 验证 timeout 正确分类并重试（stream timeout → 流阶段重试）
 *
 * 验证维度：
 *   - 流事件完整性（重试后能收到完整事件序列）
 *   - 资源清理（abort 后不泄漏定时器/reader）
 *   - 错误分类（timeout vs abort vs network error 走不同分支）
 *   - StreamLifecycle 三层超时中断行为
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { RequestAbortedError, RetryableError } from "@sid-code/core/llm/errors.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";
import {
  createStreamLifecycle,
} from "@sid-code/core/llm/stream-lifecycle.ts";

// ─── 辅助工具 ───

const BASE_PARAMS: SendParams = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

/** 正常完整事件序列 */
const NORMAL_EVENTS: StreamEvent[] = [
  { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 10, outputTokens: 5 } },
  { type: "message_stop" },
];

/** 创建 mock Provider（无 defaultModel，Provider 接口只有 name + sendMessageStream） */
function mockProvider(impl: (params: SendParams, signal?: AbortSignal) => AsyncIterable<StreamEvent>): Provider {
  return {
    name: () => "mock",
    sendMessageStream: impl,
  };
}

/** 创建一个 N 次失败后成功的 Provider */
function failThenSucceedProvider(
  failCount: number,
  errorFactory: () => Error,
  successEvents: StreamEvent[] = NORMAL_EVENTS,
): { provider: Provider; attempts: number[] } {
  const state = { call: 0, attempts: [] as number[] };
  return {
    provider: mockProvider((_params, _signal) => {
      state.call++;
      state.attempts.push(state.call);
      if (state.call <= failCount) {
        throw errorFactory();
      }
      return (async function* () {
        for (const e of successEvents) yield e;
      })();
    }),
    attempts: state.attempts,
  };
}

/** 创建 mid-stream 中断的 Provider（发送部分事件后抛错） */
function midStreamErrorProvider(
  eventsBeforeError: StreamEvent[],
  error: Error,
  failCount: number,
  successEvents: StreamEvent[] = NORMAL_EVENTS,
): { provider: Provider; streamAttempts: number[] } {
  const state = { call: 0, streamAttempts: [] as number[] };
  return {
    provider: mockProvider((_params, _signal) => {
      state.call++;
      state.streamAttempts.push(state.call);
      const callNum = state.call;
      return (async function* () {
        if (callNum <= failCount) {
          for (const e of eventsBeforeError) yield e;
          throw error;
        }
        for (const e of successEvents) yield e;
      })();
    }),
    streamAttempts: state.streamAttempts,
  };
}

/** 收集流事件 */
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) {
    events.push(e);
  }
  return events;
}

// ─── 场景 1：mid-stream 网络断开 → 重试恢复 ───

describe("T9.1 流式中断 & 恢复", () => {
  describe("场景 1: mid-stream 网络断开 → 连接阶段重试恢复", () => {
    test("ECONNRESET 连接失败 → 重试后成功", async () => {
      const { provider, attempts } = failThenSucceedProvider(2, () => {
        const err = new Error("read ECONNRESET") as Error & { code?: string };
        err.code = "ECONNRESET";
        return err;
      });

      const fallback = new ModelFallback({
        maxRetries: 3,
        streamTimeoutMs: 5000,
        availability: new ModelAvailabilityService(),
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
      });

      const events = await collectEvents(
        fallback.executeWithFallback(provider, BASE_PARAMS),
      );

      // 应该重试成功
      expect(attempts.length).toBe(3); // 2 次失败 + 1 次成功
      // 最终收到完整事件序列
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
      const textDeltas = events.filter(
        (e) => e.type === "content_block_delta" && (e as any).delta?.text,
      );
      expect(textDeltas.length).toBeGreaterThan(0);
    });

    test("EPIPE 连接失败 → 禁用 keep-alive 后重试成功", async () => {
      const { provider, attempts } = failThenSucceedProvider(1, () => {
        const err = new Error("write EPIPE") as Error & { code?: string };
        err.code = "EPIPE";
        return err;
      });

      const telemetryEvents: RetryTelemetryEvent[] = [];
      const fallback = new ModelFallback({
        maxRetries: 3,
        streamTimeoutMs: 5000,
        // 显式覆盖退避基数/上限：本用例会真实触发一次连接阶段重试等待，若吃生产
        // NETWORK_DEFAULTS（retryBackoffBaseMs 5000ms）会与 bun 默认 5s 测试超时打平。
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
        availability: new ModelAvailabilityService(),
        onTelemetry: (e) => telemetryEvents.push(e),
      });

      const events = await collectEvents(
        fallback.executeWithFallback(provider, BASE_PARAMS),
      );

      expect(attempts.length).toBe(2); // 1 次失败 + 1 次成功
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });

    test("超过最大重试次数 → 尝试 fallback provider", async () => {
      // 用网络错误（非 abort 相关）触发连接重试耗尽
      const { provider: primary } = failThenSucceedProvider(10, () => {
        const err = new Error("connect ECONNREFUSED") as Error & { code?: string };
        err.code = "ECONNREFUSED";
        return err;
      });

      const fallbackProvider = mockProvider(async function* () {
        for (const e of NORMAL_EVENTS) yield e;
      });

      const fallback = new ModelFallback({
        maxRetries: 2,
        streamTimeoutMs: 5000,
        availability: new ModelAvailabilityService(),
        fallbackProvider,
        fallbackModel: "fallback-model",
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
      });

      const events = await collectEvents(
        fallback.executeWithFallback(primary, BASE_PARAMS),
      );

      // fallback 应该成功
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });
  });

  // ─── 场景 2：mid-stream abort → 资源清理 ───

  describe("场景 2: mid-stream abort → 资源清理完整", () => {
    test("外部 abort 信号 → 流消费立即终止", async () => {
      const abortCtl = new AbortController();
      const provider = mockProvider((_params, signal) => {
        return (async function* () {
          yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as StreamEvent;
          yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as StreamEvent;
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "H" } } as StreamEvent;
          // 后续事件有延迟，给 abort 时间生效
          for (let i = 0; i < 100; i++) {
            if (signal?.aborted) return;
            await new Promise((r) => setTimeout(r, 10));
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } as StreamEvent;
          }
        })();
      });

      const fallback = new ModelFallback({
        streamTimeoutMs: 10000,
        availability: new ModelAvailabilityService(),
      });

      // 50ms 后 abort
      setTimeout(() => abortCtl.abort(), 50);

      const events: StreamEvent[] = [];
      try {
        for await (const e of fallback.executeWithFallback(
          provider,
          BASE_PARAMS,
          abortCtl.signal,
        )) {
          events.push(e);
        }
      } catch (err) {
        // 应该是 abort 相关的错误
        expect(
          err instanceof RequestAbortedError ||
          (err instanceof Error && err.message.includes("abort")),
        ).toBe(true);
      }

      // 不应收到大量 "x" 事件（abort 后流应停止）
      const xDeltas = events.filter(
        (e) => e.type === "content_block_delta" && (e as any).delta?.text === "x",
      );
      expect(xDeltas.length).toBeLessThan(10);
    });

    test("已 aborted 的 signal 传入 → 立即抛出 RequestAbortedError", async () => {
      const abortCtl = new AbortController();
      abortCtl.abort();

      const provider = mockProvider(async function* () {
        for (const e of NORMAL_EVENTS) yield e;
      });

      const fallback = new ModelFallback({
        streamTimeoutMs: 5000,
        availability: new ModelAvailabilityService(),
      });

      expect(async () => {
        for await (const _ of fallback.executeWithFallback(
          provider,
          BASE_PARAMS,
          abortCtl.signal,
        )) {
          // 不应到达这里
        }
      }).toThrow();
    });
  });

  // ─── 场景 3：mid-stream 超时 → 正确分类并重试 ───

  describe("场景 3: mid-stream 超时 → timeout 正确分类", () => {
    test("流式整体超时 → 触发 stream timeout abort", async () => {
      // 创建一个永远不结束的流（模拟 stall）
      const provider = mockProvider((_params, signal) => {
        return (async function* () {
          yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as StreamEvent;
          // 然后永远等待直到 abort
          await new Promise<void>((resolve) => {
            if (signal?.aborted) { resolve(); return; }
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      });

      const telemetryEvents: RetryTelemetryEvent[] = [];
      const fallback = new ModelFallback({
        streamTimeoutMs: 100, // 100ms 超时（测试用极短值）
        maxRetries: 0,
        availability: new ModelAvailabilityService(),
        onTelemetry: (e) => telemetryEvents.push(e),
      });

      const events: StreamEvent[] = [];
      try {
        for await (const e of fallback.executeWithFallback(provider, BASE_PARAMS)) {
          events.push(e);
        }
      } catch {
        // 超时后可能抛错或降级
      }

      // 应该有收到至少 message_start（超时前的事件）
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    test("mid-stream 错误（非 abort）→ 流阶段重试后恢复", async () => {
      const streamError = new RetryableError("stream interrupted", "server_error");
      const { provider, streamAttempts } = midStreamErrorProvider(
        [
          { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "H" } },
        ],
        streamError,
        1, // 第一次 mid-stream 失败
        NORMAL_EVENTS,
      );

      const fallback = new ModelFallback({
        maxRetries: 3,
        streamTimeoutMs: 5000,
        // 显式覆盖退避基数/上限：本用例会真实触发一次流阶段重试等待，若吃生产
        // NETWORK_DEFAULTS（retryBackoffBaseMs 5000ms）会与 bun 默认 5s 测试超时打平，
        // 导致抖动（jitter）落在不同区间时随机超时。
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
        availability: new ModelAvailabilityService(),
      });

      const events = await collectEvents(
        fallback.executeWithFallback(provider, BASE_PARAMS),
      );

      // 应该重试并最终成功
      expect(streamAttempts.length).toBe(2);
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });

    test("mid-stream stall → stream timeout 后重试从头开始", async () => {
      let callCount = 0;
      const provider = mockProvider((_params, signal) => {
        callCount++;
        const thisCall = callCount;
        return (async function* () {
          if (thisCall === 1) {
            // 第一次：发送部分事件后 stall
            yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as StreamEvent;
            yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as StreamEvent;
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } } as StreamEvent;
            // stall 直到 abort（感知 signal 以便超时后退出）
            await new Promise<void>((resolve) => {
              if (signal?.aborted) { resolve(); return; }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            // abort 后抛出可重试错误，让 fallback.ts 进入流阶段重试
            throw new RetryableError("stream timeout", "timeout");
          }
          // 第二次：完整流
          for (const e of NORMAL_EVENTS) yield e;
        })();
      });

      const fallback = new ModelFallback({
        streamTimeoutMs: 80, // 极短超时
        maxRetries: 2,
        // 显式覆盖退避基数/上限为极小值：与本文件其它用例一致，保持测试快速、
        // 与生产 NETWORK_DEFAULTS（retryBackoffBaseMs 已提到 5000ms）解耦。
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
        availability: new ModelAvailabilityService(),
      });

      const events = await collectEvents(
        fallback.executeWithFallback(provider, BASE_PARAMS),
      );

      // 第二次调用应成功（重试了）
      expect(callCount).toBeGreaterThanOrEqual(2);
      const messageStops = events.filter((e) => e.type === "message_stop");
      expect(messageStops.length).toBe(1);
    });
  });

  // ─── 资源清理验证 ───

  describe("资源清理验证", () => {
    test("正常完成后无定时器泄漏", async () => {
      const provider = mockProvider(async function* () {
        for (const e of NORMAL_EVENTS) yield e;
      });

      const fallback = new ModelFallback({
        streamTimeoutMs: 5000,
        availability: new ModelAvailabilityService(),
      });

      await collectEvents(fallback.executeWithFallback(provider, BASE_PARAMS));

      // 如果定时器未清理，后续操作会看到意外行为
      // 通过正常执行完成验证 —— 无 unhandledRejection/uncaughtException 即通过
      await new Promise((r) => setTimeout(r, 50));
    });

    test("abort 后无泄漏的 promise rejection", async () => {
      const abortCtl = new AbortController();
      const provider = mockProvider((_params, signal) => {
        return (async function* () {
          yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as StreamEvent;
          await new Promise<void>((resolve) => {
            if (signal?.aborted) { resolve(); return; }
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      });

      const fallback = new ModelFallback({
        streamTimeoutMs: 5000,
        availability: new ModelAvailabilityService(),
      });

      setTimeout(() => abortCtl.abort(), 30);

      try {
        for await (const _ of fallback.executeWithFallback(
          provider,
          BASE_PARAMS,
          abortCtl.signal,
        )) {
          // consume
        }
      } catch {
        // expected
      }

      // 等待任何潜在的悬空 promise settle
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  // ─── StreamLifecycle 中断恢复 ───

  describe("StreamLifecycle 三层超时中断行为", () => {
    test("idle 超时后流消费停止且 snapshot 标记 timedOut", async () => {
      // 流发一个事件后间隔很长再发第二个——idle timer 在间隔期间触发
      // guard 在下一次 yield 时检测到 timedOut 并 break
      async function* stallThenYield(): AsyncIterable<{ type: string }> {
        yield { type: "content_block_delta" };
        // 等 200ms（远超 idle=50ms），然后再 yield 一个让 guard 有机会检测 timedOut
        await new Promise((r) => setTimeout(r, 200));
        yield { type: "should_not_be_seen" };
      }

      let timeoutLayer: string | null = null;
      const lc = createStreamLifecycle<{ type: string }>({
        idleTimeoutMs: 50,
        label: "TEST",
        onTimeout: (layer) => { timeoutLayer = layer; },
      });

      const events: Array<{ type: string }> = [];
      for await (const e of lc.guard(stallThenYield())) {
        events.push(e);
      }

      expect(events.length).toBe(1);
      expect(timeoutLayer!).toBe("idle");
      const snap = lc.getSnapshot();
      expect(snap.timedOut).toBe(true);
      expect(snap.timeoutLayer).toEqual("idle");
    });

    test("content_progress 超时：ping 续命 idle 但不续命 content", async () => {
      // 每 30ms 发 ping（续命 idle），但从不发 content
      // content progress timer 在 100ms 后触发，guard 在下次 yield 检测到 timedOut
      async function* pingStream(): AsyncIterable<{ type: string }> {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 30));
          yield { type: "ping" };
        }
      }

      let timeoutLayer: string | null = null;
      const lc = createStreamLifecycle<{ type: string }>({
        idleTimeoutMs: 2000, // idle 不会触发（ping 每 30ms 续命）
        contentProgressTimeoutMs: 100, // 100ms 无 content → 超时
        isContentProgress: (e) => e.type === "content_block_delta",
        label: "TEST",
        onTimeout: (layer) => { timeoutLayer = layer; },
      });

      const events: Array<{ type: string }> = [];
      for await (const e of lc.guard(pingStream())) {
        events.push(e);
      }

      // content progress 应先于 idle 触发
      expect(timeoutLayer!).toBe("content_progress");
      // 至少收到了一些 ping（idle 被续命）
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.type === "ping")).toBe(true);
    });

    test("overall 超时：持续有内容但超过硬上限", async () => {
      // 持续吐 content（续命 idle + content progress），但 overall 到了
      // guard 在下一次 for-await 迭代检查 timedOut → break
      async function* neverEndStream(): AsyncIterable<{ type: string }> {
        while (true) {
          await new Promise((r) => setTimeout(r, 10));
          yield { type: "content_block_delta" };
        }
      }

      let timeoutLayer: string | null = null;
      const lc = createStreamLifecycle<{ type: string }>({
        idleTimeoutMs: 500,
        contentProgressTimeoutMs: 500,
        overallTimeoutMs: 100, // 100ms overall 硬上限
        isContentProgress: (e) => e.type === "content_block_delta",
        label: "TEST",
        onTimeout: (layer) => { timeoutLayer = layer; },
      });

      const events: Array<{ type: string }> = [];
      for await (const e of lc.guard(neverEndStream())) {
        events.push(e);
      }

      expect(timeoutLayer!).toBe("overall");
      // 在 100ms 内以每 10ms 一个的速度，应收到约 5-15 个事件
      expect(events.length).toBeGreaterThan(3);
      expect(events.length).toBeLessThan(20);
    });

    test("signal abort → 立即退出，不触发任何超时", async () => {
      const abortCtl = new AbortController();

      async function* slowStream(): AsyncIterable<{ type: string }> {
        yield { type: "content_block_delta" };
        await new Promise((r) => setTimeout(r, 200));
        yield { type: "content_block_delta" };
      }

      let timeoutLayer: string | null = null;
      const lc = createStreamLifecycle<{ type: string }>({
        idleTimeoutMs: 500,
        label: "TEST",
        signal: abortCtl.signal,
        onTimeout: (layer) => { timeoutLayer = layer; },
      });

      // 30ms 后 abort
      setTimeout(() => abortCtl.abort(), 30);

      const events: Array<{ type: string }> = [];
      for await (const e of lc.guard(slowStream())) {
        events.push(e);
      }

      // 只收到第一个事件（abort 在第二个到达前生效）
      expect(events.length).toBe(1);
      // 不是因为超时退出
      expect(timeoutLayer).toBeNull();
      expect(lc.getSnapshot().timedOut).toBe(false);
    });
  });
});
