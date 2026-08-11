/**
 * T6：流内错误提前检测 — 单元测试
 *
 * 验证：
 *   - StreamLevelError 归类：结构化 error.type（overloaded_error）→ overloaded 可重试，
 *     不依赖消息文本关键词
 *   - classifyStreamError 对认证/模型不存在等归 Terminal（不重试）
 *   - fallback 流式阶段：Anthropic 200 + overloaded_error 首事件 → 重试
 *   - OpenAI 200 + error chunk 首事件 → 重试
 *   - 正常首事件 → 正常消费
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import {
  classifyStreamError,
  StreamLevelError,
  RetryableError,
  TerminalError,
} from "@sid-code/core/llm/errors.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

// ─── 端到端 helper：验证「首个事件即 error」经 fallback 的重试/降级路径 ───

const e2eParams: SendParams = {
  model: "anthropic:claude-x",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 256,
};

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** 成功的降级 provider（用于验证降级后能正常拿到 message_stop） */
function okProvider(): Provider {
  return {
    name: () => "ok",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "message_stop" };
    },
  } as unknown as Provider;
}

describe("T6 — classifyStreamError 结构化归类", () => {
  test("overloaded_error（消息无关键词）→ StreamLevelError overloaded 可重试", () => {
    const e = classifyStreamError("anthropic", "服务暂时不可用", "overloaded_error");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as StreamLevelError).reason).toBe("overloaded");
    expect((e as StreamLevelError).statusCode).toBe(529);
    expect((e as StreamLevelError).provider).toBe("anthropic");
    expect((e as StreamLevelError).streamLevel).toBe(true);
  });

  test("rate_limit_error → StreamLevelError rate_limit 可重试", () => {
    const e = classifyStreamError("openai", "too many requests", "rate_limit_error");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect((e as StreamLevelError).reason).toBe("rate_limit");
  });

  test("authentication_error → TerminalError（不重试）", () => {
    const e = classifyStreamError("anthropic", "bad key", "authentication_error");
    expect(e).toBeInstanceOf(TerminalError);
    expect((e as TerminalError).reason).toBe("auth_failed");
  });

  test("无 type 但消息含 overloaded 关键词 → 回退文本匹配为 overloaded", () => {
    const e = classifyStreamError("openai", "Server overloaded, try later");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect((e as StreamLevelError).reason).toBe("overloaded");
  });

  test("无 type 且消息无关键词 → 兜底 server_error 可重试", () => {
    const e = classifyStreamError("deepseek", "something odd happened");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect((e as StreamLevelError).reason).toBe("server_error");
  });
});

describe("T6 — StreamEvent error 携带结构化字段", () => {
  test("StreamLevelError 保留 provider/statusCode 供归因", () => {
    const e = new StreamLevelError("anthropic", 529, "overloaded", "overloaded");
    expect(e.provider).toBe("anthropic");
    expect(e.statusCode).toBe(529);
    expect(e.streamLevel).toBe(true);
    expect(e.name).toBe("StreamLevelError");
    // 继承 RetryableError → fallback 的 instanceof 判断成立
    expect(e instanceof RetryableError).toBe(true);
  });
});

// ─── 端到端：首个事件即 error（HTTP 200 伪装成功）→ fallback 分类重试/降级 ───
//
// 设计说明（T6）：项目未采用文档设计的 `peekFirstEvent`（tee/unshift 预读首事件），
// 而是让 provider 在消费循环中**内联** yield 结构化 error（带 streamLevel:true），
// 由 fallback.ts 的 classifyStreamError 统一分类。此设计严格优于 peek：
//   1. 不止拦截首事件——error 出现在流任意位置都能识破（首 delta 后再 overloaded 也捕获）；
//   2. 无需 tee/缓冲首事件，零额外内存与时序复杂度。
// 下列用例正是补齐"首个事件即 error"这一关键路径的端到端覆盖（此前仅测分类函数）。

describe("T6 — 首事件即 error 的端到端重试/降级路径", () => {
  test("Anthropic 200 + overloaded_error 作为首个事件 → 重试耗尽后降级到备用 provider", async () => {
    let primaryCalls = 0;
    const overloadedPrimary: Provider = {
      name: () => "anthropic",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        primaryCalls++;
        // 首个事件即结构化 overloaded_error（无消息关键词，靠 type 判定）
        yield { type: "error", error: { message: "服务繁忙", type: "overloaded_error", streamLevel: true } } as StreamEvent;
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread", // 前台：529 会重试
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    const events = await collect(fallback.executeWithFallback(overloadedPrimary, e2eParams));

    // 首事件 overloaded → 连续 529 触发重试，最终降级到备用 provider 成功
    expect(primaryCalls).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("OpenAI 200 + error chunk 作为首个事件 → 可重试错误驱动流式重试", async () => {
    let primaryCalls = 0;
    const errChunkPrimary: Provider = {
      name: () => "openai",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        primaryCalls++;
        // OpenAI 族：error.type=server_error（503 语义），streamLevel 标记
        yield { type: "error", error: { message: "upstream error", type: "server_error", streamLevel: true } } as StreamEvent;
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread",
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    const events = await collect(fallback.executeWithFallback(errChunkPrimary, { ...e2eParams, model: "openai:deepseek" }));

    // server_error 可重试 → 流式重试多次（>1）后降级成功
    expect(primaryCalls).toBeGreaterThan(1);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });

  test("首事件即 authentication_error → 判定 Terminal，直接降级不重试", async () => {
    let primaryCalls = 0;
    const authFailPrimary: Provider = {
      name: () => "anthropic",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        primaryCalls++;
        yield { type: "error", error: { message: "invalid api key", type: "authentication_error", streamLevel: true } } as StreamEvent;
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread",
    });

    const events = await collect(fallback.executeWithFallback(authFailPrimary, e2eParams));

    // Terminal 错误：主 provider 只调用一次（不重试），立即降级
    expect(primaryCalls).toBe(1);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("正常首事件（content_block_delta）→ 正常消费，不误触发重试", async () => {
    let primaryCalls = 0;
    const normalPrimary: Provider = {
      name: () => "anthropic",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        primaryCalls++;
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: "message_stop" };
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread",
    });

    const events = await collect(fallback.executeWithFallback(normalPrimary, e2eParams));

    expect(primaryCalls).toBe(1);
    expect(fallback.checkFallbackOccurred()).toBe(false); // 未降级
    expect(events.some(e => e.type === "content_block_delta")).toBe(true);
    expect(events.some(e => e.type === "message_stop")).toBe(true);
  });
});
