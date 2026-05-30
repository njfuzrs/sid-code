/**
 * MockProvider — LLM Provider 的可控失败测试替身
 *
 * 实现: ADR-021 §2.1 mock provider 框架
 *
 * 4 种 failPattern × failAfterRequests 倒计时:
 *   - "ok"          始终成功 (走 responseTemplate)
 *   - "503"         RetryableError(reason=overloaded)
 *   - "rate_limit"  RetryableError(reason=rate_limit, retryAfterMs)
 *   - "timeout"     RetryableError(reason=timeout)
 *
 * 注: failAfterRequests=N 表示前 N 次成功, 第 N+1 次起按 failPattern 失败.
 *      默认 0 = 第一次就失败.
 */

import type { Provider, ProviderCapabilities } from "../provider.ts";
import type { SendParams, StreamEvent } from "../types.ts";
import { RetryableError } from "../errors.ts";

/** Mock Provider 失败模式 */
export type MockFailPattern = "ok" | "503" | "rate_limit" | "timeout";

/** Mock Provider 配置 */
export interface MockProviderConfig {
  /** Provider 名称 (主要用于 router 识别), 如 "mock-503" / "mock-quota-exceeded" */
  name: string;
  /** 失败模式 */
  failPattern: MockFailPattern;
  /** 成功路径下的固定文本响应 (默认 "mock response") */
  responseTemplate?: string;
  /**
   * 第 N 次请求开始失败 (0-based 倒计时).
   *   0 = 第一次就失败 (默认).
   *   3 = 前 3 次成功, 第 4 次起按 failPattern 失败.
   */
  failAfterRequests?: number;
  /** rate_limit 模式下的 retryAfterMs (默认 1000) */
  retryAfterMs?: number;
  /** 默认模型名 (router 配置兼容用) */
  model?: string;
}

/** Mock Provider 实现 */
export class MockProvider implements Provider {
  private cfg: Required<Omit<MockProviderConfig, "responseTemplate">> & {
    responseTemplate: string;
  };
  private requestCount: number = 0;

  constructor(cfg: MockProviderConfig) {
    if (!cfg.name) throw new Error("MockProvider: name 必填");
    if (!["ok", "503", "rate_limit", "timeout"].includes(cfg.failPattern)) {
      throw new Error(`MockProvider: 未知 failPattern: ${cfg.failPattern}`);
    }
    this.cfg = {
      name: cfg.name,
      failPattern: cfg.failPattern,
      responseTemplate: cfg.responseTemplate ?? "mock response",
      failAfterRequests: cfg.failAfterRequests ?? 0,
      retryAfterMs: cfg.retryAfterMs ?? 1000,
      model: cfg.model ?? "mock-model",
    };
  }

  name(): string {
    return this.cfg.name;
  }

  defaultModel(): string {
    return this.cfg.model;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      thinking: false,
      vision: false,
      promptCaching: false,
      parallelToolCalls: true,
    };
  }

  /** 已发起的请求次数 (单测用) */
  getRequestCount(): number {
    return this.requestCount;
  }

  /** 重置计数器 (跨 case 复用 mock 时用) */
  reset(): void {
    this.requestCount = 0;
  }

  async *sendMessageStream(
    _params: SendParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    this.requestCount += 1;
    const shouldFail =
      this.cfg.failPattern !== "ok" && this.requestCount > this.cfg.failAfterRequests;

    if (shouldFail) {
      // 模拟 abort 行为 — 如果调用方传了已中断的 signal, 优先抛 AbortError
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Request aborted");
      }
      throw this.buildFailError();
    }

    // 成功路径: 模拟 streaming 一段固定文本
    yield {
      type: "message_start",
      message: { usage: { inputTokens: 0, outputTokens: 0 } },
    };
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: this.cfg.responseTemplate },
    };
    yield { type: "content_block_stop", index: 0 };
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        inputTokens: 10,
        outputTokens: this.cfg.responseTemplate.length,
      },
    };
    yield { type: "message_stop" };
  }

  private buildFailError(): Error {
    switch (this.cfg.failPattern) {
      case "503":
        return new RetryableError(
          `Mock 503 Service Unavailable (${this.cfg.name})`,
          "overloaded",
        );
      case "rate_limit":
        return new RetryableError(
          `Mock 429 Rate Limit (${this.cfg.name})`,
          "rate_limit",
          this.cfg.retryAfterMs,
        );
      case "timeout":
        return new RetryableError(
          `Mock Timeout (${this.cfg.name})`,
          "timeout",
        );
      default:
        // unreachable — failPattern=ok 时 shouldFail=false 不会进入此分支
        throw new Error(`MockProvider: unexpected failPattern ${this.cfg.failPattern}`);
    }
  }
}

/** 工厂函数 (符合 ADR-021 §2.1 接口签名) */
export function createMockProvider(cfg: MockProviderConfig): Provider {
  return new MockProvider(cfg);
}
