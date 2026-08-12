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
import { ModelFallback, FOREGROUND_SOURCES } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { RequestAbortedError } from "@sid-code/core/llm/errors.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";

/** 创建一个成功的 Mock Provider */
function successProvider(events?: StreamEvent[]): Provider {
  return {
    name: () => "mock",

    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      const defaultEvents: StreamEvent[] = events ?? [
        { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
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

    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "error", error: { message: errorMsg } };
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
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  // === Terminal 错误不重试 ===
  test("Terminal 错误（认证失败）直接进入 fallback", async () => {
    const availability = new ModelAvailabilityService();
    const fallbackProv = successProvider();
    const fallback = new ModelFallback({
      availability,
      fallbackProvider: fallbackProv,
      fallbackModel: "fallback-model",
    });

    const events = await collectEvents(
      fallback.executeWithFallback(errorEventProvider("401 Unauthorized"), defaultParams),
    );

    // 应该有来自 fallback 的事件
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
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

    const fallback = new ModelFallback({
      availability,
      fallbackProvider: trackingFallback,
      fallbackModel: "fallback-model",
    });

    await collectEvents(fallback.executeWithFallback(successProvider(), defaultParams));

    expect(fallbackCalled).toBe(true);
  });

  // === 无 fallback 时返回错误 ===
  test("无 fallback Provider 时返回错误事件", async () => {
    const fallback = new ModelFallback();
    const events = await collectEvents(
      fallback.executeWithFallback(errorEventProvider("401 Unauthorized"), defaultParams),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  // === 流式空响应验证 ===
  test("空响应触发 StreamValidationError 并重试", async () => {
    // Provider 返回空流（无 content_block_delta）
    const emptyProvider: Provider = {
      name: () => "mock",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield { type: "message_stop" };
      },
    };

    // 退避基数压到 1ms：本测试只验证重试逻辑，不测真实退避时长（避免 2s 基数 × 指数退避超时）。
    const fallback = new ModelFallback({ retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 });
    const events = await collectEvents(fallback.executeWithFallback(emptyProvider, defaultParams));

    // 最终应该有错误（因为重试后仍然空）
    const hasError = events.some((e) => e.type === "error");
    const hasStop = events.some((e) => e.type === "message_stop");
    // 要么有错误事件，要么有 message_stop（来自重试）
    expect(hasError || hasStop).toBe(true);
  });

  // === fallback 空响应校验（事故复盘 session 20260708-102143）===
  // 背景：主模型 terminal 失败触发降级，但 fallback provider 返回空流（0 内容事件，
  // 如网关回 text/html 错误页）。此前 tryFallback 直接透传空流 → 上层 stopReason=null
  // 静默收尾，用户界面毫无提示。修复：tryFallback 补齐与主路径对齐的空响应校验，
  // fallback 空流也必须抛 StreamValidationError（经上层转成可见错误）。
  test("fallback provider 返回空响应 → 抛 StreamValidationError（不静默透传空流）", async () => {
    // 主 provider terminal 失败（触发降级）
    const primary = errorEventProvider("401 Unauthorized");
    // fallback provider 返回空流（只有 message_stop，无任何内容/工具/error 事件）
    const emptyFallback: Provider = {
      name: () => "mock-fallback",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield { type: "message_stop" };
      },
    };

    const fallback = new ModelFallback({
      fallbackProvider: emptyFallback,
      fallbackModel: "fallback-model",
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    // 关键断言：fallback 空流必须产出 error 事件（经上层转 throw 展示），而非静默成功收尾。
    // 用 error 事件而非 throw，避免被流式重试循环 recatch 重分类成语焉不详的"无可用 fallback"。
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).error.type).toBe("empty_response");
    expect((errorEvent as any).error.streamLevel).toBe(true);
    expect((errorEvent as any).error.message).toContain("空响应");
  });

  // === fallback 流内 error 事件透传（不叠加"响应为空"掩盖真实原因）===
  test("fallback provider 产出 error 事件 → 透传该 error，不误报空响应", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    // fallback provider 产出显式 error（如 openai.ts 的 Content-Type 守卫）
    const erroringFallback = errorEventProvider("网关返回非流式响应（Content-Type: text/html）");

    const fallback = new ModelFallback({
      fallbackProvider: erroringFallback,
      fallbackModel: "fallback-model",
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    // 应透传 fallback 的具体 error，而非抛"响应为空"掩盖真实原因
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).error.message).toContain("Content-Type");
  });

  // === Listener 回调 ===
  test("重试时触发 onRetry 回调", async () => {
    const retries: { attempt: number; error: string }[] = [];

    const fallback = new ModelFallback(
      { retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 },
      {
        onRetry: (attempt, error) => {
          retries.push({ attempt, error });
        },
      },
    );

    // 使用一个流式错误 Provider（可重试的 503）
    const provider = errorEventProvider("503 Service Unavailable");
    await collectEvents(fallback.executeWithFallback(provider, defaultParams));

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
      fallback.executeWithFallback(errorEventProvider("401 Unauthorized"), defaultParams),
    );

    expect(fallbackModel).toBe("backup-model");
    expect(fallbackReason).toBeTruthy();
  });

  test("切 fallback 时按 fallback 模型注册表上限钳制 maxTokens（根因A配套）", async () => {
    // 主模型 maxTokens 384000（如 deepseek），降级到 glm-5.2（注册表上限 128000）时，
    // fallback provider 收到的 maxTokens 必须被钳到 128000，否则 fallback 调用自己也会 400。
    let seenMaxTokens: number | undefined;
    let seenModel: string | undefined;
    const capturingFallback: Provider = {
      name: () => "mock",
      async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
        seenMaxTokens = params.maxTokens;
        seenModel = params.model;
        yield* successProvider().sendMessageStream(defaultParams);
      },
    };
    const fallback = new ModelFallback({
      fallbackProvider: capturingFallback,
      fallbackModel: "glm-5.2",
    });

    await collectEvents(
      fallback.executeWithFallback(errorEventProvider("401 Unauthorized"), {
        ...defaultParams,
        maxTokens: 384000,
      }),
    );

    expect(seenModel).toBe("glm-5.2");
    expect(seenMaxTokens).toBe(128000);
  });

  test("fallback 模型上限足够时不下调 maxTokens", async () => {
    // fallback 到 deepseek-v4-pro（上限 384000），主 maxTokens 200000 在上限内 → 原样透传。
    let seenMaxTokens: number | undefined;
    const capturingFallback: Provider = {
      name: () => "mock",
      async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
        seenMaxTokens = params.maxTokens;
        yield* successProvider().sendMessageStream(defaultParams);
      },
    };
    const fallback = new ModelFallback({
      fallbackProvider: capturingFallback,
      fallbackModel: "deepseek-v4-pro",
    });

    await collectEvents(
      fallback.executeWithFallback(errorEventProvider("401 Unauthorized"), {
        ...defaultParams,
        maxTokens: 200000,
      }),
    );

    expect(seenMaxTokens).toBe(200000);
  });

  test("用户中断时不重试也不 fallback", async () => {
    let fallbackCalled = false;
    const fallbackProv: Provider = {
      name: () => "fallback",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        fallbackCalled = true;
        yield* successProvider().sendMessageStream(defaultParams);
      },
    };

    const fallback = new ModelFallback({
      fallbackProvider: fallbackProv,
      fallbackModel: "backup-model",
    });

    await expect(
      collectEvents(
        fallback.executeWithFallback(errorEventProvider("Request aborted"), defaultParams),
      ),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    expect(fallbackCalled).toBe(false);
  });

  // === reset ===
  test("reset 重置 hasFallenBack 状态", async () => {
    const fallback = new ModelFallback({
      fallbackProvider: successProvider(),
      fallbackModel: "backup",
    });

    // 第一次触发 fallback
    await collectEvents(
      fallback.executeWithFallback(errorEventProvider("401 Unauthorized"), defaultParams),
    );

    // reset 后可以再次使用 fallback
    fallback.reset();

    const events = await collectEvents(
      fallback.executeWithFallback(errorEventProvider("401 Unauthorized"), defaultParams),
    );

    // 应该有来自 fallback 的事件
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
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
    const telemetryEvents: RetryTelemetryEvent[] = [];

    // Provider 第一次抛 401，第二次成功
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",

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

    const fallback = new ModelFallback({
      fallbackProvider: successProvider(),
      fallbackModel: "fallback",
      onTelemetry: (e) => telemetryEvents.push(e),
    });

    const events = await collectEvents(fallback.executeWithFallback(provider, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(callCount).toBe(2); // 第一次 401，第二次重试成功
    expect(telemetryEvents.some((e) => e.type === "auth_refresh")).toBe(true);
  });

  test("401 连接阶段重试后仍失败进入 fallback", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",

      sendMessageStream(): AsyncIterable<StreamEvent> {
        callCount++;
        const err = new Error("401 Unauthorized") as any;
        err.status = 401;
        throw err;
      },
    };

    const fallback = new ModelFallback({
      fallbackProvider: successProvider(),
      fallbackModel: "fallback",
    });

    const events = await collectEvents(fallback.executeWithFallback(provider, defaultParams));

    // 两次连接尝试（initial + refresh retry），然后进入 fallback
    expect(callCount).toBe(2);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  // ─── ECONNRESET / keep-alive ───
  test("ECONNRESET 后重试成功（连接阶段）", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",

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

    // 显式覆盖退避基数/上限为极小值：与本文件其它用例一致，保持测试快速、
    // 与生产 NETWORK_DEFAULTS（retryBackoffBaseMs 已提到 5000ms）解耦。
    const fallback = new ModelFallback({ retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 });
    const events = await collectEvents(fallback.executeWithFallback(provider, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(callCount).toBe(2);
  });

  // ─── max_tokens 溢出自动恢复 ───
  test("max_tokens 溢出自动恢复重试成功", async () => {
    let maxTokensAdjusted = false;
    const adjustedValues: number[] = [];

    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",

      sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          async function* gen(): AsyncIterable<StreamEvent> {
            yield {
              type: "error",
              error: {
                message:
                  "input length and max_tokens exceed context limit: 188059 + 20000 > 200000",
              },
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
      {
        contextLimit: 200000,
        // 显式覆盖退避基数/上限为极小值：本用例会真实触发一次连接阶段重试等待，
        // 若吃生产 NETWORK_DEFAULTS（retryBackoffBaseMs 已提到 5000ms）会与 bun
        // 默认 5s 测试超时打平，导致抖动（jitter）落在不同区间时随机超时。
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
      },
      {
        onMaxTokensAdjusted: (orig, adj) => {
          maxTokensAdjusted = true;
        },
      },
    );

    const events = await collectEvents(
      fallback.executeWithFallback(provider, { ...defaultParams, maxTokens: 20000 }),
    );

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
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

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield {
          type: "error",
          error: {
            message: "input length and max_tokens exceed context limit: 995000 + 20000 > 1000000",
          },
        };
      },
    };

    const fallback = new ModelFallback(
      { contextLimit: 1_000_000, retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 },
      {
        onMaxTokensAdjusted: () => {
          maxTokensAdjusted = true;
        },
      },
    );
    const events = await collectEvents(
      fallback.executeWithFallback(provider, { ...defaultParams, maxTokens: 20000 }),
    );

    // floor 太高 → 未做 max_tokens 恢复（错误透出，由上层处理）
    expect(maxTokensAdjusted).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("#8：SID_RECOVERY_FLOOR_TOKENS 放宽 floor 后可从同样的溢出中恢复", async () => {
    const saved = process.env.SID_RECOVERY_FLOOR_TOKENS;
    try {
      process.env.SID_RECOVERY_FLOOR_TOKENS = "3000"; // 显式放宽到 3000
      let callCount = 0;
      const adjustedValues: number[] = [];
      const provider: Provider = {
        name: () => "mock",

        sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
          callCount++;
          if (callCount === 1) {
            async function* gen(): AsyncIterable<StreamEvent> {
              yield {
                type: "error",
                error: {
                  message:
                    "input length and max_tokens exceed context limit: 995000 + 20000 > 1000000",
                },
              };
            }
            return gen();
          }
          adjustedValues.push(params.maxTokens);
          return successProvider().sendMessageStream(defaultParams);
        },
      };

      const fallback = new ModelFallback({
        contextLimit: 1_000_000,
        retryBackoffBaseMs: 1,
        retryBackoffMaxMs: 5,
      });
      const events = await collectEvents(
        fallback.executeWithFallback(provider, { ...defaultParams, maxTokens: 20000 }),
      );

      // floor 放宽到 3000 后，剩余 ~4000 ≥ 3000 → 恢复成功
      expect(callCount).toBe(2);
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
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

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        callCount++;
        yield { type: "error", error: { message: "529 overloaded" } };
      },
    };

    const fallback = new ModelFallback({
      fallbackProvider: successProvider(),
      fallbackModel: "fallback",
      querySource: "main_thread",
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    const events = await collectEvents(fallback.executeWithFallback(provider, defaultParams));

    // 连续 3 次（流式 retry maxRetries=2，共 3 次尝试），触发 fallback
    expect(callCount).toBe(3);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("后台 529 立即放弃（不重试）", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: () => "mock",

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
        on529Dropped: () => {
          droppedCalled = true;
        },
      },
    );

    const events = await collectEvents(fallback.executeWithFallback(provider, defaultParams));

    // 后台只尝试一次
    expect(callCount).toBe(1);
    expect(droppedCalled).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
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
      aborted =
        err instanceof RequestAbortedError || (err as Error)?.name === "RequestAbortedError";
    } finally {
      clearTimeout(abortTimer);
    }

    // 进入了 persistent 无限等待：emit persistent_retry_wait，未降级 fallback
    expect(telemetry.some((e) => e.type === "persistent_retry_wait")).toBe(true);
    expect(telemetry.some((e) => e.type === "fallback")).toBe(false);
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
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
    expect(telemetry.some((e) => e.type === "persistent_retry_wait")).toBe(false);
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
      for await (const e of fallback.executeWithFallback(
        throwRetryableProvider(),
        defaultParams,
        ctl.signal,
      )) {
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
    const { shouldRetry529 } = require("@sid-code/core/llm/fallback.ts");
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

    const fallback = new ModelFallback({
      fallbackProvider: successProvider(),
      fallbackModel: "fallback",
      onTelemetry: (e) => events.push(e),
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    await collectEvents(
      fallback.executeWithFallback(errorEventProvider("503 Service Unavailable"), defaultParams),
    );

    // 至少应有 retry 和 fallback 事件
    const retryEvents = events.filter((e) => e.type === "retry");
    const fallbackEvents = events.filter((e) => e.type === "fallback");
    expect(retryEvents.length).toBeGreaterThan(0);
    expect(fallbackEvents.length).toBeGreaterThan(0);
  });

  // ─── 可配置流超时 ───
  test("自定义 streamTimeoutMs", async () => {
    const fallback = new ModelFallback({ streamTimeoutMs: 30_000 });
    const events = await collectEvents(
      fallback.executeWithFallback(successProvider(), defaultParams),
    );
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  // ─── 流超时 → 主动中断 → 重试 → fallback（P0 僵死回归）───
  test("流 hang 触发超时 abort 时走重试/fallback 而非永久阻塞", async () => {
    // 模拟「流 hang」：provider 监听传入 signal，signal abort 后抛出
    // SDK 风格的 abort 错误；signal 不 abort 则永远不产出任何事件（卡死）。
    const hangProvider: Provider = {
      name: () => "mock-hang",

      async *sendMessageStream(_p: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Request was aborted."));
          signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), {
            once: true,
          });
        });
        yield { type: "message_stop" };
      },
    };

    // 50ms 超时即触发中断；fallback provider 兜底返回正常结果。
    // 显式覆盖退避基数/上限为极小值：流式阶段默认重试 2 次，若吃生产 NETWORK_DEFAULTS
    // （retryBackoffBaseMs 5000ms）会累计 ~15s 退避等待，超出本用例的 10s 超时。
    const fallback = new ModelFallback({
      streamTimeoutMs: 50,
      fallbackProvider: successProvider(),
      fallbackModel: "fallback-model",
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    // 必须在合理时间内完成（不会永久卡死），且最终拿到 fallback 的 message_stop
    const events = await collectEvents(fallback.executeWithFallback(hangProvider, defaultParams));
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  }, 10_000);

  // ─── 用户主动 ESC 中断必须传播，不被当成超时重试 ───
  test("用户 abort（外部 signal）立即传播 RequestAbortedError", async () => {
    const hangProvider: Provider = {
      name: () => "mock-hang",

      async *sendMessageStream(_p: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), {
            once: true,
          });
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

  // ─── P0-2 §7.1 回归：真半开流（provider 内部完全不感知 signal）必须靠外层 race 逃逸 ───
  test("P0-2: provider 流内部完全不感知 abort（真半开）→ 外层 race 仍需在 1s 内 reject，不 hang 到 streamTimeoutMs", async () => {
    // 关键区别于上面两个既有用例：此 mock 的生成器 yield 一个事件后，挂在一个
    // **永不 resolve/reject 且不监听 signal** 的 Promise 上——完全模拟"SSE 半开：
    // TCP 连接在、服务端不再发 event，reader.read() 永不 settle"，且 provider 自身
    // 对 signal 一无所知（不像旧测试里 mock 主动监听 abort 来自救）。
    // 若 fallback.ts 的 for-await 仍是旧模式（无外层 Promise.race），本用例会真实 hang
    // 到 streamTimeoutMs（这里特意设置得很长）才被动触发，从而暴露回归。
    let neverSettles: () => void = () => {};
    const hangProvider: Provider = {
      name: () => "mock-real-hang",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        };
        // 挂起：不监听 signal，不 resolve，不 reject —— 唯一能救出来的只有外层 race。
        await new Promise<void>((_resolve, _reject) => {
          neverSettles = () => {
            /* 有意留空：证明此 Promise 永不 settle */
          };
        });
        yield { type: "message_stop" };
      },
    };

    const userController = new AbortController();
    // streamTimeoutMs 故意设得很长（60s），确保测试只可能因为"外层 abort race"提前退出，
    // 而不是因为 fallback 自己的整体超时兜底凑巧也在合理时间内触发。
    const fallback = new ModelFallback({ streamTimeoutMs: 60_000 });
    setTimeout(() => userController.abort(), 100);

    const start = Date.now();
    await expect(
      collectEvents(
        fallback.executeWithFallback(hangProvider, defaultParams, userController.signal),
      ),
    ).rejects.toBeInstanceOf(RequestAbortedError);
    const elapsed = Date.now() - start;
    // 必须远早于 60s 的 streamTimeoutMs，证明是外层 race 生效而非兜底超时
    expect(elapsed).toBeLessThan(2_000);
    neverSettles(); // 消除 "unused variable" 顾虑，语义上标记该 promise 本就设计为不 settle
  }, 10_000);
});

describe("T6 — 流内错误提前检测（stream-level error）", () => {
  /** 首事件即 overloaded_error（消息不含关键词），首次调用 fail、第二次成功 */
  function streamOverloadedThenSuccess(): Provider {
    let attempts = 0;
    return {
      name: () => "mock",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        attempts++;
        if (attempts === 1) {
          // HTTP 200 但流内首事件是伪装成功的错误：消息文本无 "overloaded"/"529" 关键词，
          // 只有结构化 type 字段——靠 T6 的 classifyStreamError 才能判成可重试。
          yield {
            type: "error",
            error: { message: "服务暂时不可用", type: "overloaded_error", streamLevel: true },
          } as StreamEvent;
          return;
        }
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "recovered" },
        };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        yield { type: "message_stop" };
      },
    };
  }

  test("Anthropic 200 + overloaded_error 首事件（消息无关键词）→ 重试后成功", async () => {
    const fallback = new ModelFallback({ maxRetries: 2, streamTimeoutMs: 60_000 });
    const events = await collectEvents(
      fallback.executeWithFallback(streamOverloadedThenSuccess(), {
        ...defaultParams,
        model: "anthropic:claude-x",
      }),
    );
    // 重试后成功消费到内容 + 正常收尾
    expect(events.some((e) => e.type === "content_block_delta")).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  }, 10_000);

  test("OpenAI 200 + error chunk 首事件 → 重试后成功", async () => {
    let attempts = 0;
    const provider: Provider = {
      name: () => "mock",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        attempts++;
        if (attempts === 1) {
          yield {
            type: "error",
            error: {
              message: "OpenAI 流内错误: upstream busy",
              type: "server_error",
              streamLevel: true,
            },
          } as StreamEvent;
          return;
        }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        yield { type: "message_stop" };
      },
    };
    const fallback = new ModelFallback({ maxRetries: 2, streamTimeoutMs: 60_000 });
    const events = await collectEvents(
      fallback.executeWithFallback(provider, { ...defaultParams, model: "openai:gpt-x" }),
    );
    expect(events.some((e) => e.type === "content_block_delta")).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 10_000);

  test("正常首事件 → 正常消费（不误触发重试）", async () => {
    let attempts = 0;
    const provider: Provider = {
      name: () => "mock",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        attempts++;
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        yield { type: "message_stop" };
      },
    };
    const fallback = new ModelFallback({ maxRetries: 2 });
    const events = await collectEvents(fallback.executeWithFallback(provider, defaultParams));
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(attempts).toBe(1); // 未重试
  });

  test("流内认证错误（terminal）不重试 → 进 fallback", async () => {
    const availability = new ModelAvailabilityService();
    const failing: Provider = {
      name: () => "mock",

      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield {
          type: "error",
          error: { message: "凭证无效", type: "authentication_error", streamLevel: true },
        } as StreamEvent;
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
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

// ─── fallbackSwitchMode 三态切换（询问用户 / 自动 / 禁用降级） ───
describe("ModelFallback — fallbackSwitchMode", () => {
  test("off：不降级，直接报错终止本轮，即使配置了 fallbackProvider", async () => {
    const primary = errorEventProvider("401 Unauthorized"); // terminal，直入 tryFallback
    const fallback = new ModelFallback({
      fallbackSwitchMode: "off",
      fallbackProvider: successProvider(),
      fallbackModel: "backup",
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(false);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).error.message).toContain("off");
    expect(fallback.checkFallbackOccurred()).toBe(false);
  });

  test("auto（默认，无 onFallbackDecision 钩子）：保持旧行为，直接切 fallbackModel", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    const fallback = new ModelFallback({
      fallbackSwitchMode: "auto",
      fallbackProvider: successProvider(),
      fallbackModel: "backup",
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("ask + 钩子返回 switch(默认模型)：切到钩子指定的 provider/model", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    const backupProvider = successProvider();
    let decisionCtx: any = null;

    const fallback = new ModelFallback({
      fallbackSwitchMode: "ask",
      fallbackModel: "backup", // 仅作为 defaultFallbackModel 透传给钩子，不直接使用
      onFallbackDecision: async (ctx) => {
        decisionCtx = ctx;
        return { action: "switch", model: "backup", provider: backupProvider };
      },
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    expect(decisionCtx).not.toBeNull();
    expect(decisionCtx.failedModel).toBe(defaultParams.model);
    expect(decisionCtx.defaultFallbackModel).toBe("backup");
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("ask + 钩子返回 switch(任意 availableModels 模型)：不受 config.fallbackModel 限制", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    const otherProvider = successProvider();

    const fallback = new ModelFallback({
      fallbackSwitchMode: "ask",
      fallbackModel: "backup", // 钩子选了别的模型，不应受此限制
      onFallbackDecision: async () => ({
        action: "switch",
        model: "some-other-model",
        provider: otherProvider,
      }),
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("ask + 钩子返回 abort：不切换，yield error 终止本轮", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    const fallback = new ModelFallback({
      fallbackSwitchMode: "ask",
      fallbackProvider: successProvider(),
      fallbackModel: "backup",
      onFallbackDecision: async () => ({ action: "abort" }),
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(false);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(fallback.checkFallbackOccurred()).toBe(false);
  });

  test("ask + 无 onFallbackDecision 钩子：退化为 auto 行为（headless 场景）", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    const fallback = new ModelFallback({
      fallbackSwitchMode: "ask",
      // 未注入 onFallbackDecision（headless/SDK 模式不会注入 handler）
      fallbackProvider: successProvider(),
      fallbackModel: "backup",
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("ask + 钩子抛异常：fail-open 到 auto（切默认 fallbackModel，不中断任务）", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    const fallback = new ModelFallback({
      fallbackSwitchMode: "ask",
      fallbackProvider: successProvider(),
      fallbackModel: "backup",
      onFallbackDecision: async () => {
        throw new Error("askUserQuestion 内部异常（模拟 TUI 未就绪）");
      },
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    // fail-open：钩子异常不应中断任务，应回退到切默认 fallbackModel
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("ask + 钩子抛异常 + 无默认 fallbackModel：fail-open 后仍无可用目标 → abort", async () => {
    const primary = errorEventProvider("401 Unauthorized");
    const fallback = new ModelFallback({
      fallbackSwitchMode: "ask",
      // 无 fallbackProvider/fallbackModel：fail-open 的 auto 兜底也找不到目标
      onFallbackDecision: async () => {
        throw new Error("模拟异常");
      },
    });

    const events = await collectEvents(fallback.executeWithFallback(primary, defaultParams));

    expect(events.some((e) => e.type === "message_stop")).toBe(false);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(fallback.checkFallbackOccurred()).toBe(false);
  });

  test("二次降级（已用过 fallback）：不再重复调用 onFallbackDecision，直接报错", async () => {
    // 主 provider 每次都失败 → 第一次触发 tryFallback 切换成功后，fallback provider
    // 本身若也失败，第二次进 tryFallback 应直接因 hasFallenBack 短路，不再问用户。
    let decisionCalls = 0;
    const alwaysFailing = errorEventProvider("401 Unauthorized");
    const alsoFailingBackup = errorEventProvider("401 Unauthorized");

    const fallback = new ModelFallback({
      fallbackSwitchMode: "ask",
      onFallbackDecision: async () => {
        decisionCalls++;
        return { action: "switch", model: "backup", provider: alsoFailingBackup };
      },
    });

    const events = await collectEvents(fallback.executeWithFallback(alwaysFailing, defaultParams));

    // fallback provider 本身也是 terminal 错误 → streamFromFallback 透传其 error 事件，
    // 不会再次进 tryFallback（terminal 错误走的是 errorEventProvider 的裸 error 事件，
    // 由 streamFromFallback 判定 fbYieldedError=true 后原样收尾，不触发二次决策）。
    expect(decisionCalls).toBe(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });
});
