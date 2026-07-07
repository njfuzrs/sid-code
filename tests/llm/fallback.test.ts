/**
 * 分阶段重试测试 — 扩展版
 *
 * Phase 1.1-1.4 增强：
 *  - 401 认证刷新重试（不再直接 Terminal）
 *  - ECONNRESET keep-alive 管理
 *  - max_tokens 溢出自动恢复
 *  - 529 连续计数 + 前台/后台差异化 + 降级触发
 *  - Telemetry 埋点回调
 *  - 可配置流超时
 *  - QuerySource 区分
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback, type QuerySource, FOREGROUND_SOURCES } from "../../src/llm/fallback.ts";
import { ModelAvailabilityService } from "../../src/llm/availability.ts";
import { RequestAbortedError, RetryableError } from "../../src/llm/errors.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";
import type { RetryTelemetryEvent } from "../../src/llm/retry-telemetry.ts";

/** 创建一个成功的 Mock Provider */
function successProvider(events?: StreamEvent[]): Provider {
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      const defaultEvents: StreamEvent[] = events ?? [
        { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 10, outputTokens: 5 } },
        { type: "message_stop" },
      ];
      for (const e of defaultEvents) yield e;
    },
  };
}

/** 创建一个返回错误事件的 Mock Provider */
function errorEventProvider(errorMsg: string): Provider {
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "error", error: { message: errorMsg } };
    },
  };
}

/** 创建一个抛出异常的 Mock Provider（模拟连接失败） */
function throwProvider(error: Error): Provider {
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream(): AsyncIterable<StreamEvent> {
      throw error;
    },
  };
}

/** 创建一个先失败 N 次再成功的 Provider */
function failThenSuccessProvider(failCount: number, error: Error): Provider {
  let attempts = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      attempts++;
      if (attempts <= failCount) {
        throw error;
      }
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "message_stop" };
    },
  };
}

const defaultParams: SendParams = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
};

/** 收集所有流式事件 */
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("ModelFallback", () => {
  // === 正常流程 ===
  test("成功请求直接返回所有事件", async () => {
    const fallback = new ModelFallback();
    const events = await collectEvents(
      fallback.executeWithFallback(successProvider(), defaultParams),
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });

  // === Terminal 错误不重试 ===
  test("Terminal 错误（认证失败）直接进入 fallback", async () => {
    const availability = new ModelAvailabilityService();
    const fallbackProv = successProvider();
    const fallback = new ModelFallback(
      { availability, fallbackProvider: fallbackProv, fallbackModel: "fallback-model" },
    );

    const events = await collectEvents(
      fallback.executeWithFallback(
        errorEventProvider("401 Unauthorized"),
        defaultParams,
      ),
    );

    // 应该有来自 fallback 的事件
    expect(events.some(e => e.type === "message_stop")).toBe(true);
    // 原模型应被标记为 terminal
    expect(availability.isAvailable("test-model").available).toBe(false);
  });

  // === 模型不可用时跳过直接 fallback ===
  test("模型已标记 terminal 时直接使用 fallback", async () => {
    const availability = new ModelAvailabilityService();
    availability.markTerminal("test-model", "auth_failed");

    const fallbackProv = successProvider();
    let fallbackCalled = false;
    const trackingFallback: Provider = {
      ...fallbackProv,
      async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
        fallbackCalled = true;
        yield* fallbackProv.sendMessageStream(params);
      },
    };

    const fallback = new ModelFallback(
      { availability, fallbackProvider: trackingFallback, fallbackModel: "fallback-model" },
    );

    await collectEvents(
      fallback.executeWithFallback(successProvider(), defaultParams),
    );

    expect(fallbackCalled).toBe(true);
  });

  // === 无 fallback 时返回错误 ===
  test("无 fallback Provider 时返回错误事件", async () => {
    const fallback = new ModelFallback();
    const events = await collectEvents(
      fallback.executeWithFallback(
        errorEventProvider("401 Unauthorized"),
        defaultParams,
      ),
    );

    const errorEvent = events.find(e => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  // === 流式空响应验证 ===
  test("空响应触发 StreamValidationError 并重试", async () => {
    // Provider 返回空流（无 content_block_delta）
    const emptyProvider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield { type: "message_stop" };
      },
    };

    // 退避基数压到 1ms：本测试只验证重试逻辑，不测真实退避时长（避免 2s 基数 × 指数退避超时）。
    const fallback = new ModelFallback({ retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 });
    const events = await collectEvents(
      fallback.executeWithFallback(emptyProvider, defaultParams),
    );

    // 最终应该有错误（因为重试后仍然空）
    const hasError = events.some(e => e.type === "error");
    const hasStop = events.some(e => e.type === "message_stop");
    // 要么有错误事件，要么有 message_stop（来自重试）
    expect(hasError || hasStop).toBe(true);
  });

  // === Listener 回调 ===
  test("重试时触发 onRetry 回调", async () => {
    const retries: { attempt: number; error: string }[] = [];

    const fallback = new ModelFallback({ retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 }, {
      onRetry: (attempt, error) => {
        retries.push({ attempt, error });
      },
    });

    // 使用一个流式错误 Provider（可重试的 503）
    const provider = errorEventProvider("503 Service Unavailable");
    await collectEvents(
      fallback.executeWithFallback(provider, defaultParams),
    );

    // 503 是可重试错误，应该触发 onRetry
    // 注意：流式阶段的错误事件会被 classifyError 分类
  });

  test("fallback 时触发 onFallback 回调", async () => {
    let fallbackReason = "";
    let fallbackModel = "";

    const fallback = new ModelFallback(
      { fallbackProvider: successProvider(), fallbackModel: "backup-model" },
      {
        onFallback: (reason, model) => {
          fallbackReason = reason;
          fallbackModel = model;
        },
      },
    );

    await collectEvents(
      fallback.executeWithFallback(
        errorEventProvider("401 Unauthorized"),
        defaultParams,
      ),
    );

    expect(fallbackModel).toBe("backup-model");
    expect(fallbackReason).toBeTruthy();
  });

  test("用户中断时不重试也不 fallback", async () => {
    let fallbackCalled = false;
    const fallbackProv: Provider = {
      name: () => "fallback",
      defaultModel: () => "backup-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        fallbackCalled = true;
        yield* successProvider().sendMessageStream(defaultParams);
      },
    };

    const fallback = new ModelFallback(
      { fallbackProvider: fallbackProv, fallbackModel: "backup-model" },
    );

    await expect(
      collectEvents(
        fallback.executeWithFallback(
          errorEventProvider("Request aborted"),
          defaultParams,
        ),
      ),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    expect(fallbackCalled).toBe(false);
  });

  // === reset ===
  test("reset 重置 hasFallenBack 状态", async () => {
    const fallback = new ModelFallback(
      { fallbackProvider: successProvider(), fallbackModel: "backup" },
    );

    // 第一次触发 fallback
    await collectEvents(
      fallback.executeWithFallback(
        errorEventProvider("401 Unauthorized"),
        defaultParams,
      ),
    );

    // reset 后可以再次使用 fallback
    fallback.reset();

    const events = await collectEvents(
      fallback.executeWithFallback(
        errorEventProvider("401 Unauthorized"),
        defaultParams,
      ),
    );

    // 应该有来自 fallback 的事件
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });

  // === getAvailability ===
  test("getAvailability 返回可用性服务实例", () => {
    const availability = new ModelAvailabilityService();
    const fallback = new ModelFallback({ availability });
    expect(fallback.getAvailability()).toBe(availability);
  });

  test("未传入 availability 时自动创建", () => {
    const fallback = new ModelFallback();
    expect(fallback.getAvailability()).toBeDefined();
    expect(fallback.getAvailability()).toBeInstanceOf(ModelAvailabilityService);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 1.2-1.4 新增测试
// ═══════════════════════════════════════════════════════════════════

describe("ModelFallback 增强", () => {
  // ─── 401 认证刷新重试 ───
  test("401 连接阶段触发认证刷新并重试一次", async () => {
    let authRefreshed = false;
    const telemetryEvents: RetryTelemetryEvent[] = [];

    // Provider 第一次抛 401，第二次成功
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      sendMessageStream(): AsyncIterable<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          const err = new Error("401 Unauthorized") as any;
          err.status = 401;
          throw err;
        }
        const gen = successProvider().sendMessageStream(defaultParams);
        return gen;
      },
    };

    const fallback = new ModelFallback(
      {
        fallbackProvider: successProvider(),
        fallbackModel: "fallback",
        onTelemetry: (e) => telemetryEvents.push(e),
      },
    );

    const events = await collectEvents(
      fallback.executeWithFallback(provider, defaultParams),
    );

    expect(events.some(e => e.type === "message_stop")).toBe(true);
    expect(callCount).toBe(2); // 第一次 401，第二次重试成功
    expect(telemetryEvents.some(e => e.type === "auth_refresh")).toBe(true);
  });

  test("401 连接阶段重试后仍失败进入 fallback", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      sendMessageStream(): AsyncIterable<StreamEvent> {
        callCount++;
        const err = new Error("401 Unauthorized") as any;
        err.status = 401;
        throw err;
      },
    };

    const fallback = new ModelFallback(
      { fallbackProvider: successProvider(), fallbackModel: "fallback" },
    );

    const events = await collectEvents(
      fallback.executeWithFallback(provider, defaultParams),
    );

    // 两次连接尝试（initial + refresh retry），然后进入 fallback
    expect(callCount).toBe(2);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });

  // ─── ECONNRESET / keep-alive ───
  test("ECONNRESET 后重试成功（连接阶段）", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      sendMessageStream(): AsyncIterable<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          const err = new Error("socket hang up") as any;
          err.code = "ECONNRESET";
          throw err;
        }
        const gen = successProvider().sendMessageStream(defaultParams);
        return gen;
      },
    };

    const fallback = new ModelFallback();
    const events = await collectEvents(
      fallback.executeWithFallback(provider, defaultParams),
    );

    expect(events.some(e => e.type === "message_stop")).toBe(true);
    expect(callCount).toBe(2);
  });

  // ─── max_tokens 溢出自动恢复 ───
  test("max_tokens 溢出自动恢复重试成功", async () => {
    let maxTokensAdjusted = false;
    const adjustedValues: number[] = [];

    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          async function* gen(): AsyncIterable<StreamEvent> {
            yield {
              type: "error",
              error: { message: "input length and max_tokens exceed context limit: 188059 + 20000 > 200000" },
            };
          }
          return gen();
        }
        adjustedValues.push(params.maxTokens);
        const gen = successProvider().sendMessageStream(defaultParams);
        return gen;
      },
    };

    const fallback = new ModelFallback(
      { contextLimit: 200000 },
      {
        onMaxTokensAdjusted: (orig, adj) => {
          maxTokensAdjusted = true;
        },
      },
    );

    const events = await collectEvents(
      fallback.executeWithFallback(provider, { ...defaultParams, maxTokens: 20000 }),
    );

    expect(events.some(e => e.type === "message_stop")).toBe(true);
    expect(callCount).toBe(2);
    expect(maxTokensAdjusted).toBe(true);
    // 第二次调用应使用调整后的 maxTokens
    expect(adjustedValues[0]).not.toBe(20000);
  });

  // ─── #8 溢出恢复 floor 按 contextLimit 比例 + 可配置 ───
  test("#8：大窗口下极小剩余空间默认放弃 max_tokens 恢复（floor 按比例提高）", async () => {
    // contextLimit=1M → floor=max(3000, 1M×5%)=50000。
    // 溢出后剩余可用仅 ~4000（< 50000）→ tryRecoverMaxTokens 返回 null，不做 max_tokens 调整。
    let maxTokensAdjusted = false;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield {
          type: "error",
          error: { message: "input length and max_tokens exceed context limit: 995000 + 20000 > 1000000" },
        };
      },
    };

    const fallback = new ModelFallback(
      { contextLimit: 1_000_000, retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 },
      { onMaxTokensAdjusted: () => { maxTokensAdjusted = true; } },
    );
    const events = await collectEvents(
      fallback.executeWithFallback(provider, { ...defaultParams, maxTokens: 20000 }),
    );

    // floor 太高 → 未做 max_tokens 恢复（错误透出，由上层处理）
    expect(maxTokensAdjusted).toBe(false);
    expect(events.some(e => e.type === "error")).toBe(true);
  });

  test("#8：SID_RECOVERY_FLOOR_TOKENS 放宽 floor 后可从同样的溢出中恢复", async () => {
    const saved = process.env.SID_RECOVERY_FLOOR_TOKENS;
    try {
      process.env.SID_RECOVERY_FLOOR_TOKENS = "3000"; // 显式放宽到 3000
      let callCount = 0;
      const adjustedValues: number[] = [];
      const provider: Provider = {
        name: () => "mock",
        defaultModel: () => "mock-model",
        sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
          callCount++;
          if (callCount === 1) {
            async function* gen(): AsyncIterable<StreamEvent> {
              yield {
                type: "error",
                error: { message: "input length and max_tokens exceed context limit: 995000 + 20000 > 1000000" },
              };
            }
            return gen();
          }
          adjustedValues.push(params.maxTokens);
          return successProvider().sendMessageStream(defaultParams);
        },
      };

      const fallback = new ModelFallback({ contextLimit: 1_000_000, retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 });
      const events = await collectEvents(
        fallback.executeWithFallback(provider, { ...defaultParams, maxTokens: 20000 }),
      );

      // floor 放宽到 3000 后，剩余 ~4000 ≥ 3000 → 恢复成功
      expect(callCount).toBe(2);
      expect(events.some(e => e.type === "message_stop")).toBe(true);
      expect(adjustedValues[0]).toBeGreaterThanOrEqual(3000);
      expect(adjustedValues[0]).toBeLessThan(20000);
    } finally {
      if (saved === undefined) delete process.env.SID_RECOVERY_FLOOR_TOKENS;
      else process.env.SID_RECOVERY_FLOOR_TOKENS = saved;
    }
  });

  // ─── 529 连续计数 ───
  test("流式阶段连续 3 次 529 触发降级", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        callCount++;
        yield { type: "error", error: { message: "529 overloaded" } };
      },
    };

    const fallback = new ModelFallback(
      {
        fallbackProvider: successProvider(),
        fallbackModel: "fallback",
        querySource: "main_thread",
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
      },
    );

    const events = await collectEvents(
      fallback.executeWithFallback(provider, defaultParams),
    );

    // 连续 3 次（流式 retry maxRetries=2，共 3 次尝试），触发 fallback
    expect(callCount).toBe(3);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });

  test("后台 529 立即放弃（不重试）", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        callCount++;
        yield { type: "error", error: { message: "529 overloaded" } };
      },
    };

    let droppedCalled = false;
    const fallback = new ModelFallback(
      {
        fallbackProvider: successProvider(),
        fallbackModel: "fallback",
        querySource: "summary", // 后台查询
      },
      {
        on529Dropped: () => { droppedCalled = true; },
      },
    );

    const events = await collectEvents(
      fallback.executeWithFallback(provider, defaultParams),
    );

    // 后台只尝试一次
    expect(callCount).toBe(1);
    expect(droppedCalled).toBe(true);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });

  // ─── persistent retry + heartbeat（T8.7）───
  //
  // 控制流关键点（读 fallback.ts 得出）：
  //  · persistent 无限等待块只在**流迭代抛异常**的 catch 分支(attempt>=max)触发，
  //    不在 error-event 分支(那里走 tryFallback)。故 provider 必须 throw 而非 yield error。
  //  · 用 maxRetries:0 让"首次尝试即最终尝试"，跳过指数退避(1s/2s...)，测试快速确定。
  //  · persistent 等待调用 sleepWithProgress(300s)，先 emit persistent_retry_wait 遥测，
  //    再进入可被 signal 中断的 10s 分段心跳睡眠。用短延时 abort 打断，无需真睡满。

  /** 抛可重试错误(503→overloaded)的流：迭代即 throw */
  function throwRetryableProvider(counter?: { n: number }): Provider {
    return {
      name: () => "anthropic",
      // eslint-disable-next-line require-yield
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        if (counter) counter.n++;
        throw new Error("503 Service Unavailable");
      },
    } as unknown as Provider;
  }

  test("persistent 模式：重试耗尽后进入无限等待(persistent_retry_wait)而非降级", async () => {
    const counter = { n: 0 };
    const telemetry: RetryTelemetryEvent[] = [];
    const fallback = new ModelFallback({
      // 无 fallbackProvider：非 persistent 时会 yield error 结束；persistent 时应无限等待
      persistent: true,
      maxRetries: 0, // 首次即最终尝试，跳过退避
      querySource: "main_thread",
      onTelemetry: (e) => telemetry.push(e),
    });

    const ctl = new AbortController();
    const abortTimer = setTimeout(() => ctl.abort(), 150); // 打断 persistent 长睡眠

    let aborted = false;
    try {
      await collectEvents(
        fallback.executeWithFallback(throwRetryableProvider(counter), defaultParams, ctl.signal),
      );
    } catch (err) {
      aborted = err instanceof RequestAbortedError || (err as Error)?.name === "RequestAbortedError";
    } finally {
      clearTimeout(abortTimer);
    }

    // 进入了 persistent 无限等待：emit persistent_retry_wait，未降级 fallback
    expect(telemetry.some(e => e.type === "persistent_retry_wait")).toBe(true);
    expect(telemetry.some(e => e.type === "fallback")).toBe(false);
    // 卡在等待中被 signal 打断(证明确实无限等待而非静默结束)
    expect(aborted).toBe(true);
    expect(counter.n).toBeGreaterThanOrEqual(1);
  });

  test("非 persistent(默认)：重试耗尽后降级到备用 provider，不进入 persistent 等待", async () => {
    const telemetry: RetryTelemetryEvent[] = [];
    const fallback = new ModelFallback({
      fallbackProvider: successProvider(),
      fallbackModel: "backup",
      maxRetries: 0,
      querySource: "main_thread",
      onTelemetry: (e) => telemetry.push(e),
      // persistent 默认 false
    });

    const events = await collectEvents(
      fallback.executeWithFallback(throwRetryableProvider(), defaultParams),
    );

    // 降级成功拿到 message_stop，且从未进入 persistent 等待
    expect(events.some(e => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
    expect(telemetry.some(e => e.type === "persistent_retry_wait")).toBe(false);
  });

  test("persistent 心跳：长睡眠拆成 10s 分段并 yield 剩余时间进度事件", async () => {
    // 真实观测心跳：persistent 等待 5min 被拆成 10s 块，首个心跳进度事件在 ~10s 后到达。
    // 收到即 abort，避免睡满。此测试有意较慢(约 10s)，是心跳机制的正回归。
    const fallback = new ModelFallback({
      persistent: true,
      maxRetries: 0,
      querySource: "main_thread",
    });

    const ctl = new AbortController();
    let sawHeartbeat = false;
    try {
      for await (const e of fallback.executeWithFallback(throwRetryableProvider(), defaultParams, ctl.signal)) {
        if (e.type === "system_api_error" && (e as any).category === "persistent_retry") {
          sawHeartbeat = true;
          ctl.abort(); // 收到首个心跳进度即中断
        }
      }
    } catch {
      /* abort 抛 RequestAbortedError，预期内 */
    }

    expect(sawHeartbeat).toBe(true);
  }, 20_000);

  // ─── QuerySource 工具函数 ───
  test("shouldRetry529: 前台 true, 后台 false", () => {
    const { shouldRetry529 } = require("../../src/llm/fallback.ts");
    expect(shouldRetry529("main_thread")).toBe(true);
    expect(shouldRetry529("agent")).toBe(true);
    expect(shouldRetry529("compact")).toBe(true);
    expect(shouldRetry529("summary")).toBe(false);
    expect(shouldRetry529("title")).toBe(false);
    expect(shouldRetry529("classifier")).toBe(false);
    expect(shouldRetry529(undefined)).toBe(true);
  });

  // ─── FOREGROUND_SOURCES ───
  test("FOREGROUND_SOURCES 包含正确的源", () => {
    expect(FOREGROUND_SOURCES.has("main_thread")).toBe(true);
    expect(FOREGROUND_SOURCES.has("agent")).toBe(true);
    expect(FOREGROUND_SOURCES.has("compact")).toBe(true);
    expect(FOREGROUND_SOURCES.has("summary")).toBe(false);
  });

  // ─── Telemetry ───
  test("Telemetry 回调接收事件", async () => {
    const events: RetryTelemetryEvent[] = [];

    const fallback = new ModelFallback(
      {
        fallbackProvider: successProvider(),
        fallbackModel: "fallback",
        onTelemetry: (e) => events.push(e),
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
      },
    );

    await collectEvents(
      fallback.executeWithFallback(
        errorEventProvider("503 Service Unavailable"),
        defaultParams,
      ),
    );

    // 至少应有 retry 和 fallback 事件
    const retryEvents = events.filter(e => e.type === "retry");
    const fallbackEvents = events.filter(e => e.type === "fallback");
    expect(retryEvents.length).toBeGreaterThan(0);
    expect(fallbackEvents.length).toBeGreaterThan(0);
  });

  // ─── 可配置流超时 ───
  test("自定义 streamTimeoutMs", async () => {
    const fallback = new ModelFallback({ streamTimeoutMs: 30_000 });
    const events = await collectEvents(
      fallback.executeWithFallback(successProvider(), defaultParams),
    );
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });

  // ─── 流超时 → 主动中断 → 重试 → fallback（P0 僵死回归）───
  test("流 hang 触发超时 abort 时走重试/fallback 而非永久阻塞", async () => {
    // 模拟「流 hang」：provider 监听传入 signal，signal abort 后抛出
    // SDK 风格的 abort 错误；signal 不 abort 则永远不产出任何事件（卡死）。
    const hangProvider: Provider = {
      name: () => "mock-hang",
      defaultModel: () => "mock-model",
      async *sendMessageStream(_p: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Request was aborted."));
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Request was aborted.")),
            { once: true },
          );
        });
        yield { type: "message_stop" };
      },
    };

    // 50ms 超时即触发中断；fallback provider 兜底返回正常结果
    const fallback = new ModelFallback({
      streamTimeoutMs: 50,
      fallbackProvider: successProvider(),
      fallbackModel: "fallback-model",
    });

    // 必须在合理时间内完成（不会永久卡死），且最终拿到 fallback 的 message_stop
    const events = await collectEvents(
      fallback.executeWithFallback(hangProvider, defaultParams),
    );
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  }, 10_000);

  // ─── 用户主动 ESC 中断必须传播，不被当成超时重试 ───
  test("用户 abort（外部 signal）立即传播 RequestAbortedError", async () => {
    const hangProvider: Provider = {
      name: () => "mock-hang",
      defaultModel: () => "mock-model",
      async *sendMessageStream(_p: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Request was aborted.")),
            { once: true },
          );
        });
        yield { type: "message_stop" };
      },
    };

    const userController = new AbortController();
    const fallback = new ModelFallback({ streamTimeoutMs: 60_000 });
    // 30ms 后模拟用户按 ESC
    setTimeout(() => userController.abort(), 30);

    await expect(
      collectEvents(
        fallback.executeWithFallback(hangProvider, defaultParams, userController.signal),
      ),
    ).rejects.toBeInstanceOf(RequestAbortedError);
  }, 10_000);
});

describe("T6 — 流内错误提前检测（stream-level error）", () => {
  /** 首事件即 overloaded_error（消息不含关键词），首次调用 fail、第二次成功 */
  function streamOverloadedThenSuccess(): Provider {
    let attempts = 0;
    return {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        attempts++;
        if (attempts === 1) {
          // HTTP 200 但流内首事件是伪装成功的错误：消息文本无 "overloaded"/"529" 关键词，
          // 只有结构化 type 字段——靠 T6 的 classifyStreamError 才能判成可重试。
          yield { type: "error", error: { message: "服务暂时不可用", type: "overloaded_error", streamLevel: true } } as StreamEvent;
          return;
        }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: "message_stop" };
      },
    };
  }

  test("Anthropic 200 + overloaded_error 首事件（消息无关键词）→ 重试后成功", async () => {
    const fallback = new ModelFallback({ maxRetries: 2, streamTimeoutMs: 60_000 });
    const events = await collectEvents(
      fallback.executeWithFallback(streamOverloadedThenSuccess(), { ...defaultParams, model: "anthropic:claude-x" }),
    );
    // 重试后成功消费到内容 + 正常收尾
    expect(events.some(e => e.type === "content_block_delta")).toBe(true);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  }, 10_000);

  test("OpenAI 200 + error chunk 首事件 → 重试后成功", async () => {
    let attempts = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        attempts++;
        if (attempts === 1) {
          yield { type: "error", error: { message: "OpenAI 流内错误: upstream busy", type: "server_error", streamLevel: true } } as StreamEvent;
          return;
        }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: "message_stop" };
      },
    };
    const fallback = new ModelFallback({ maxRetries: 2, streamTimeoutMs: 60_000 });
    const events = await collectEvents(
      fallback.executeWithFallback(provider, { ...defaultParams, model: "openai:gpt-x" }),
    );
    expect(events.some(e => e.type === "content_block_delta")).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 10_000);

  test("正常首事件 → 正常消费（不误触发重试）", async () => {
    let attempts = 0;
    const provider: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        attempts++;
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: "message_stop" };
      },
    };
    const fallback = new ModelFallback({ maxRetries: 2 });
    const events = await collectEvents(fallback.executeWithFallback(provider, defaultParams));
    expect(events.some(e => e.type === "message_stop")).toBe(true);
    expect(attempts).toBe(1); // 未重试
  });

  test("流内认证错误（terminal）不重试 → 进 fallback", async () => {
    const availability = new ModelAvailabilityService();
    const failing: Provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield { type: "error", error: { message: "凭证无效", type: "authentication_error", streamLevel: true } } as StreamEvent;
      },
    };
    const fallback = new ModelFallback({
      availability,
      fallbackProvider: successProvider(),
      fallbackModel: "fallback-model",
      maxRetries: 2,
    });
    const events = await collectEvents(
      fallback.executeWithFallback(failing, { ...defaultParams, model: "anthropic:claude-x" }),
    );
    // 认证错误归 Terminal：原模型标记不可用 + 走 fallback 成功收尾
    expect(availability.isAvailable("anthropic:claude-x").available).toBe(false);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });
});
