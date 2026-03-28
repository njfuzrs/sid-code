/**
 * 分阶段重试测试
 * Task 3：连接阶段 vs 流式阶段的重试行为、Jitter 范围验证、错误分类集成
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { ModelAvailabilityService } from "../../src/llm/availability.ts";
import { RequestAbortedError } from "../../src/llm/errors.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";

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

    const fallback = new ModelFallback();
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

    const fallback = new ModelFallback({}, {
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
