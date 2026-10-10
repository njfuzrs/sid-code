/**
 * T6：流内错误提前检测 — 单元测试
 *
 * 验证：
 *   - 流内 error 事件经 normalizeStreamEvent → classifyFamily 归族：结构化 error.type
 *     （overloaded_error）→ transient/overloaded，不依赖消息文本关键词
 *   - 认证类归 auth_suspect（2026-10-08 起不再单次判死，按族预算重试）
 *
 * 已删除：「StreamLevelError 保留 provider/statusCode」用例——StreamLevelError 类已随
 * classifyStreamError 一起删除，流内事件现在直接归一化为 NormalizedLLMError，无对应类可测。
 *   - fallback 流式阶段：Anthropic 200 + overloaded_error 首事件 → 重试
 *   - OpenAI 200 + error chunk 首事件 → 重试
 *   - 正常首事件 → 正常消费
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { classifyFamily, normalizeStreamEvent } from "@sid-code/core/llm/error-normalize.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** 流内 error 事件 → 归一化 → 唯一分类器（取代已删除的 classifyStreamError） */
function classifyEvent(message: string, type?: string) {
  return classifyFamily(normalizeStreamEvent({ message, type, streamLevel: true }));
}

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
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      yield { type: "message_stop" };
    },
  } as unknown as Provider;
}

describe("T6 — 流内 error 事件结构化归类（classifyFamily）", () => {
  test("overloaded_error（消息无关键词）→ transient / overloaded", () => {
    const v = classifyEvent("服务暂时不可用", "overloaded_error");
    expect(v.family).toBe("transient");
    expect(v.reason).toBe("overloaded");
    expect(v.recognized).toBe(true);
  });

  test("rate_limit_error → transient / rate_limit", () => {
    const v = classifyEvent("too many requests", "rate_limit_error");
    expect(v.family).toBe("transient");
    expect(v.reason).toBe("rate_limit");
  });

  test("authentication_error → auth_suspect / auth_failed（不再意味着不重试）", () => {
    const v = classifyEvent("bad key", "authentication_error");
    expect(v.family).toBe("auth_suspect");
    expect(v.reason).toBe("auth_failed");
  });

  test("无 type 但消息含 overloaded 关键词 → 回退文本匹配为 overloaded", () => {
    const v = classifyEvent("Server overloaded, try later");
    expect(v.family).toBe("transient");
    expect(v.reason).toBe("overloaded");
  });

  test("无 type 且消息无关键词 → transient 未识别子集（仍可重试）", () => {
    // 2026-10-08 有意语义变更：旧兜底 reason=server_error；现在认不出就是 unrecognized，
    // recognized=false，受「同指纹 3 次封顶」约束，但依旧可重试。
    const v = classifyEvent("something odd happened");
    expect(v.family).toBe("transient");
    expect(v.reason).toBe("unrecognized");
    expect(v.recognized).toBe(false);
  });

  test("streamLevel 不参与分类：同一载荷 true/false 结论一致", () => {
    const a = classifyFamily(
      normalizeStreamEvent({ message: "x", type: "overloaded_error", streamLevel: true }),
    );
    const b = classifyFamily(
      normalizeStreamEvent({ message: "x", type: "overloaded_error", streamLevel: false }),
    );
    expect(a).toEqual(b);
  });
});

// ─── 端到端：首个事件即 error（HTTP 200 伪装成功）→ fallback 分类重试/降级 ───
//
// 设计说明（T6）：项目未采用文档设计的 `peekFirstEvent`（tee/unshift 预读首事件），
// 而是让 provider 在消费循环中**内联** yield 结构化 error（带 streamLevel:true），
// 由 fallback.ts 归一化后交给 classifyFamily 统一分类。此设计严格优于 peek：
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
        yield {
          type: "error",
          error: { message: "服务繁忙", type: "overloaded_error", streamLevel: true },
        } as StreamEvent;
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread", // 前台：529 会重试
      retryBackoffBaseMs: 0,
      retryBackoffMaxMs: 0,
    });

    const events = await collect(fallback.executeWithFallback(overloadedPrimary, e2eParams));

    // 首事件 overloaded → 连续 529 触发重试，最终降级到备用 provider 成功
    expect(primaryCalls).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("OpenAI 200 + error chunk 作为首个事件 → 可重试错误驱动流式重试", async () => {
    let primaryCalls = 0;
    const errChunkPrimary: Provider = {
      name: () => "openai",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        primaryCalls++;
        // OpenAI 族：error.type=server_error（503 语义），streamLevel 标记
        yield {
          type: "error",
          error: { message: "upstream error", type: "server_error", streamLevel: true },
        } as StreamEvent;
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread",
      retryBackoffBaseMs: 0,
      retryBackoffMaxMs: 0,
    });

    const events = await collect(
      fallback.executeWithFallback(errChunkPrimary, { ...e2eParams, model: "openai:deepseek" }),
    );

    // server_error 可重试 → 流式重试多次（>1）后降级成功
    expect(primaryCalls).toBeGreaterThan(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("首事件即 authentication_error → auth_suspect 预算用完（3 次）后降级", async () => {
    let primaryCalls = 0;
    const authFailPrimary: Provider = {
      name: () => "anthropic",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        primaryCalls++;
        yield {
          type: "error",
          error: { message: "invalid api key", type: "authentication_error", streamLevel: true },
        } as StreamEvent;
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread",
      retryBackoffBaseMs: 0,
      retryBackoffMaxMs: 0,
    });

    const events = await collect(fallback.executeWithFallback(authFailPrimary, e2eParams));

    // 2026-10-08 有意语义变更：I1 不再单次观测即判死。
    // auth_suspect 族最多 3 次尝试（默认 maxRetries=2 → 调用方上界也是 3），同指纹复现 3 次才降级。
    expect(primaryCalls).toBe(3);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });

  test("正常首事件（content_block_delta）→ 正常消费，不误触发重试", async () => {
    let primaryCalls = 0;
    const normalPrimary: Provider = {
      name: () => "anthropic",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        primaryCalls++;
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        yield { type: "message_stop" };
      },
    } as unknown as Provider;

    const fallback = new ModelFallback({
      fallbackProvider: okProvider(),
      fallbackModel: "backup",
      querySource: "main_thread",
      retryBackoffBaseMs: 0,
      retryBackoffMaxMs: 0,
    });

    const events = await collect(fallback.executeWithFallback(normalPrimary, e2eParams));

    expect(primaryCalls).toBe(1);
    expect(fallback.checkFallbackOccurred()).toBe(false); // 未降级
    expect(events.some((e) => e.type === "content_block_delta")).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});
