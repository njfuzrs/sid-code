/**
 * 模型回退机制
 * 分阶段重试：连接阶段快速重试，流式阶段谨慎重试
 * 集成错误分类和模型可用性服务
 */

import type { Provider } from "./provider.ts";
import type { SendParams, StreamEvent } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import {
  classifyError,
  TerminalError,
  RetryableError,
  StreamValidationError,
  isAbortError,
  toAbortError,
  RequestAbortedError,
} from "./errors.ts";
import { ModelAvailabilityService } from "./availability.ts";

/** 连接阶段重试配置（快速重试，次数多） */
const CONNECTION_RETRY = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/** 流式阶段重试配置（谨慎重试，次数少） */
const STREAM_RETRY = {
  maxRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
};

/** 回退配置 */
export interface FallbackConfig {
  fallbackProvider?: Provider;  // 降级 Provider
  fallbackModel?: string;       // 降级模型
  availability?: ModelAvailabilityService; // 模型可用性服务
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
  private availability: ModelAvailabilityService;

  constructor(config: Partial<FallbackConfig> = {}, listener?: FallbackListener) {
    this.config = {
      fallbackProvider: config.fallbackProvider,
      fallbackModel: config.fallbackModel,
    };
    this.listener = listener ?? null;
    this.availability = config.availability ?? new ModelAvailabilityService();
  }

  /** 获取可用性服务（供外部访问） */
  getAvailability(): ModelAvailabilityService {
    return this.availability;
  }

  /**
   * 执行带回退的操作
   * 分三个阶段：连接阶段重试 → 流式阶段重试 → Fallback Provider
   */
  async *executeWithFallback(
    primaryProvider: Provider,
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    // 检查模型可用性
    const availCheck = this.availability.isAvailable(params.model);
    if (!availCheck.available) {
      log.warn("FALLBACK", `模型 ${params.model} 不可用: ${availCheck.reason}`);
      // 直接跳到 fallback
      yield* this.tryFallback(params, signal);
      return;
    }

    // 阶段 1：连接（获取流对象）
    let stream: AsyncIterable<StreamEvent> | null = null;
    for (let attempt = 0; attempt <= CONNECTION_RETRY.maxRetries; attempt++) {
      try {
        log.debug("FALLBACK", `连接阶段尝试 ${attempt + 1}/${CONNECTION_RETRY.maxRetries + 1}`);
        stream = primaryProvider.sendMessageStream(params, signal);
        break; // 连接成功
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          throw toAbortError(err);
        }

        const classified = classifyError(err);

        if (classified instanceof TerminalError) {
          this.availability.markTerminal(params.model, classified.reason);
          log.error("FALLBACK", `终端错误: ${classified.reason}`);
          yield* this.tryFallback(params, signal);
          return;
        }

        if (attempt >= CONNECTION_RETRY.maxRetries) {
          log.warn("FALLBACK", `连接阶段重试 ${CONNECTION_RETRY.maxRetries} 次后仍失败`);
          this.availability.markRetryOnce(params.model, "连接失败");
          break; // 进入 fallback
        }

        // 可重试错误，计算延迟
        const isRateLimit = classified instanceof RetryableError && classified.reason === "rate_limit";
        const delayMs = classified instanceof RetryableError && classified.retryAfterMs
          ? classified.retryAfterMs
          : this.calculateDelay(attempt, CONNECTION_RETRY, isRateLimit);

        log.info("FALLBACK", `连接重试 ${attempt + 1}，延迟 ${delayMs}ms`);
        this.listener?.onRetry?.(attempt + 1, classified.message, delayMs);
        await this.sleep(delayMs, signal);
      }
    }

    if (!stream) {
      yield* this.tryFallback(params, signal);
      return;
    }

    // 阶段 2：流式消费（增加整体超时保护，防止上游 hang 时永久阻塞）
    const STREAM_TOTAL_TIMEOUT = 300_000; // 5 分钟
    let isStreamTimedOut = false;
    const streamTimeoutId = setTimeout(() => {
      isStreamTimedOut = true;
      log.warn("FALLBACK", `流式整体超时: ${STREAM_TOTAL_TIMEOUT / 1000}s`);
    }, STREAM_TOTAL_TIMEOUT);

    let hasYieldedContent = false;
    try {
      for (let attempt = 0; attempt <= STREAM_RETRY.maxRetries; attempt++) {
        try {
          log.debug("FALLBACK", `流式阶段尝试 ${attempt + 1}/${STREAM_RETRY.maxRetries + 1}`);

          for await (const event of stream) {
            if (isStreamTimedOut) {
              throw new Error(`流式响应整体超时: ${STREAM_TOTAL_TIMEOUT / 1000}秒`);
            }
            if (signal?.aborted) {
              throw new RequestAbortedError("请求已中止");
            }

            if (event.type === "error") {
              if (isAbortError(event.error.message)) {
                throw toAbortError(event.error.message);
              }

              const classified = classifyError(new Error(event.error.message));

              if (classified instanceof TerminalError) {
                this.availability.markTerminal(params.model, classified.reason);
                log.error("FALLBACK", `流式终端错误: ${classified.reason}`);
                yield* this.tryFallback(params, signal);
                return;
              }

              if (classified instanceof RetryableError && attempt < STREAM_RETRY.maxRetries) {
                log.warn("FALLBACK", `流式错误，准备重试: ${event.error.message}`);
                throw classified; // 触发流式重试
              }

              // 不可重试或已达最大重试次数，尝试 fallback
              yield* this.tryFallback(params, signal);
              return;
            }

            if (event.type === "content_block_delta") {
              hasYieldedContent = true;
            }

            yield event;
          }

          // 验证流完整性
          if (!hasYieldedContent) {
            throw new StreamValidationError("响应为空", "empty_response");
          }

          // 成功完成，标记模型健康
          this.availability.markHealthy(params.model);
          return;

        } catch (err) {
          if (signal?.aborted || isAbortError(err)) {
            throw toAbortError(err);
          }

          const classified = classifyError(err);

          if (classified instanceof TerminalError) {
            this.availability.markTerminal(params.model, classified.reason);
            log.error("FALLBACK", `终端错误: ${classified.reason}`);
            yield* this.tryFallback(params, signal);
            return;
          }

          if (attempt >= STREAM_RETRY.maxRetries) {
            log.warn("FALLBACK", `流式阶段重试 ${STREAM_RETRY.maxRetries} 次后仍失败`);
            this.availability.markRetryOnce(params.model, "流式传输失败");
            break;
          }

          // 流式重试：重新发起完整请求
          const isRateLimit = classified instanceof RetryableError && classified.reason === "rate_limit";
          const delayMs = classified instanceof RetryableError && classified.retryAfterMs
            ? classified.retryAfterMs
            : this.calculateDelay(attempt, STREAM_RETRY, isRateLimit);

          log.info("FALLBACK", `流式重试 ${attempt + 1}，延迟 ${delayMs}ms`);
          this.listener?.onRetry?.(attempt + 1, classified.message, delayMs);
          await this.sleep(delayMs, signal);

          // 重新获取流
          try {
            stream = primaryProvider.sendMessageStream(params, signal);
          } catch (reconnectErr) {
            if (signal?.aborted || isAbortError(reconnectErr)) {
              throw toAbortError(reconnectErr);
            }
            log.error("FALLBACK", `重连失败: ${reconnectErr}`);
            break;
          }
        }
      }
    } finally {
      clearTimeout(streamTimeoutId);
    }

    // 阶段 3：Fallback Provider
    yield* this.tryFallback(params, signal);
  }

  /** 尝试使用 fallback Provider */
  private async *tryFallback(
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    if (this.config.fallbackProvider && this.config.fallbackModel && !this.hasFallenBack) {
      this.hasFallenBack = true;
      const fallbackModel = this.config.fallbackModel;

      log.warn("FALLBACK", `切换到 fallback 模型: ${fallbackModel}`);
      this.listener?.onFallback?.("主模型失败", fallbackModel);

      const fallbackParams = { ...params, model: fallbackModel };
      for await (const event of this.config.fallbackProvider.sendMessageStream(fallbackParams, signal)) {
        yield event;
      }
      return;
    }

    // 没有 fallback 或已经用过 fallback
    log.error("FALLBACK", "主 Provider 失败且无可用 fallback");
    yield {
      type: "error",
      error: { message: "模型请求失败，已达最大重试次数且无可用 fallback" },
    };
  }

  /**
   * 计算重试延迟（指数退避 + 差异化 Jitter）
   * - 限流错误：+20% 正向抖动（尊重服务器最小延迟）
   * - 其他错误：±30% 双向抖动（避免惊群效应）
   */
  private calculateDelay(
    attempt: number,
    config: typeof CONNECTION_RETRY | typeof STREAM_RETRY,
    isRateLimit = false,
  ): number {
    let delay = Math.min(
      config.initialDelayMs * Math.pow(2, attempt),
      config.maxDelayMs,
    );

    if (isRateLimit) {
      // 限流错误：+20% 正向抖动
      delay += delay * 0.2 * Math.random();
    } else {
      // 其他错误：±30% 双向抖动
      const jitter = delay * 0.3;
      delay += Math.random() * jitter * 2 - jitter;
    }

    return Math.round(delay);
  }

  /** 异步睡眠 */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new RequestAbortedError("Request aborted"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new RequestAbortedError("Request aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 检查是否发生了模型降级 */
  checkFallbackOccurred(): boolean {
    return this.hasFallenBack;
  }

  /** 重置回退状态（用于新的请求） */
  reset(): void {
    this.hasFallenBack = false;
  }
}
