/**
 * 模型回退机制
 * 遇到 rate_limit/overloaded 等错误时指数退避重试，
 * 重试失败后自动切换到 fallback 模型
 */

import type { Provider } from "./provider.ts";
import type { SendParams, StreamEvent } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 可重试的错误类型 */
const RETRYABLE_ERRORS = [
  "overloaded_error",
  "rate_limit_error",
  "api_error",
  "timeout",
  "ECONNRESET",
  "capacity_exceeded",
  "503",
  "502",
  "429",
];

/** 回退配置 */
export interface FallbackConfig {
  maxRetries: number;           // 最大重试次数（默认 3）
  initialDelayMs: number;       // 初始延迟（默认 1000ms）
  maxDelayMs: number;           // 最大延迟（默认 30000ms）
  fallbackProvider?: Provider;  // 降级 Provider
  fallbackModel?: string;       // 降级模型
}

/** 回退事件监听器 */
export interface FallbackListener {
  onRetry?: (attempt: number, error: string, delayMs: number) => void;
  onFallback?: (reason: string, fallbackModel: string) => void;
}

export class ModelFallback {
  private config: FallbackConfig;
  private listener: FallbackListener | null;
  private hasFallenBack = false;

  constructor(config: Partial<FallbackConfig> = {}, listener?: FallbackListener) {
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      initialDelayMs: config.initialDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 30000,
      fallbackProvider: config.fallbackProvider,
      fallbackModel: config.fallbackModel,
    };
    this.listener = listener ?? null;
  }

  /**
   * 执行带回退的操作
   * 1. 先用主 Provider 重试
   * 2. 重试失败后切换到 fallback Provider（如果配置了）
   */
  async *executeWithFallback(
    primaryProvider: Provider,
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    // 第一阶段：主 Provider 重试
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        log.debug("FALLBACK", `尝试主 Provider (attempt ${attempt + 1}/${this.config.maxRetries + 1})`);

        // 返回流式响应
        for await (const event of primaryProvider.sendMessageStream(params, signal)) {
          // 检查是否是错误事件
          if (event.type === "error") {
            const errorMsg = event.error.message;
            if (this.isRetryableError(errorMsg) && attempt < this.config.maxRetries) {
              // 可重试错误，跳出内层循环进行重试
              log.warn("FALLBACK", `遇到可重试错误: ${errorMsg}`);
              throw new Error(errorMsg);
            }
            // 不可重试或已达最大重试次数，直接抛出
            yield event;
            return;
          }
          yield event;
        }
        // 成功完成，直接返回
        return;
      } catch (err: any) {
        const errorMsg = err.message || String(err);

        if (!this.isRetryableError(errorMsg) || attempt >= this.config.maxRetries) {
          // 不可重试或已达最大重试次数
          if (attempt >= this.config.maxRetries) {
            log.warn("FALLBACK", `主 Provider 重试 ${this.config.maxRetries} 次后仍失败`);
          }
          break; // 跳到 fallback 阶段
        }

        // 优先使用 retry-after 头（如果错误信息中包含），否则指数退避
        const retryAfterMs = this.parseRetryAfter(errorMsg);
        const delayMs = retryAfterMs ?? Math.min(
          this.config.initialDelayMs * Math.pow(2, attempt),
          this.config.maxDelayMs,
        );

        log.info("FALLBACK", `重试 ${attempt + 1}/${this.config.maxRetries}，延迟 ${delayMs}ms${retryAfterMs ? ' (来自 retry-after)' : ' (指数退避)'}`);
        this.listener?.onRetry?.(attempt + 1, errorMsg, delayMs);

        // 等待后重试
        await this.sleep(delayMs);
      }
    }

    // 第二阶段：Fallback Provider
    if (this.config.fallbackProvider && this.config.fallbackModel && !this.hasFallenBack) {
      this.hasFallenBack = true;
      const fallbackModel = this.config.fallbackModel;

      log.warn("FALLBACK", `切换到 fallback 模型: ${fallbackModel}`);
      this.listener?.onFallback?.("主模型重试失败", fallbackModel);

      // 使用 fallback Provider
      const fallbackParams = { ...params, model: fallbackModel };
      for await (const event of this.config.fallbackProvider.sendMessageStream(fallbackParams, signal)) {
        yield event;
      }
      return;
    }

    // 没有 fallback 或已经用过 fallback，返回错误
    log.error("FALLBACK", "主 Provider 失败且无可用 fallback");
    yield {
      type: "error",
      error: { message: "模型请求失败，已达最大重试次数且无可用 fallback" },
    };
  }

  /** 检查错误是否可重试 */
  private isRetryableError(errorMsg: string): boolean {
    const lowerMsg = errorMsg.toLowerCase();
    return RETRYABLE_ERRORS.some(pattern => lowerMsg.includes(pattern.toLowerCase()));
  }

  /** 从错误信息中解析 retry-after 值（秒），返回毫秒数；解析失败返回 null */
  private parseRetryAfter(errorMsg: string): number | null {
    // 匹配常见格式：retry-after: 30, retry_after: 30, "retry-after":"30"
    const match = errorMsg.match(/retry[_-]after[:\s"]*(\d+)/i);
    if (match) {
      const seconds = parseInt(match[1], 10);
      if (seconds > 0 && seconds <= 300) {
        return seconds * 1000;
      }
    }
    return null;
  }

  /** 异步睡眠 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 重置回退状态（用于新的请求） */
  reset(): void {
    this.hasFallenBack = false;
  }
}
