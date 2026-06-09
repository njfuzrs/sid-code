/**
 * @deprecated 此模块已废弃，所有能力已吸收至 src/llm/fallback.ts
 *
 * 保留为兼容层，提供 re-export 以维持现有测试通过。
 * 请迁移至 src/llm/fallback.ts 中的 ModelFallback 和相关导出。
 *
 * 原来职责（已迁移）：
 * - 通过 yield 向 UI 层报告重试进度（→ fallback.ts FallbackListener + SystemAPIErrorMessage）
 * - 前台 / 后台查询差异化重试（→ fallback.ts QuerySource + shouldRetry529）
 * - 529 连续 N 次 → 触发模型降级（→ fallback.ts 连续 529 计数 + tryFallback）
 * - max_tokens 溢出自动计算安全值（→ fallback.ts tryRecoverMaxTokens）
 * - ECONNRESET → 标记 keep-alive（→ fallback.ts RetryContext.disableKeepAlive）
 * - 401 → 触发认证刷新（→ fallback.ts RetryContext.needsAuthRefresh）
 */

// Re-export 从 fallback.ts（这些类型和函数已迁移到核心引擎）
export {
  type QuerySource,
  FOREGROUND_SOURCES,
  shouldRetry529,
} from "../llm/fallback.ts";

import { isAbortError, RequestAbortedError, getNetworkErrorCode } from "../llm/errors.ts";
import {
  classifyAPIError,
  getErrorMessageForUser,
  parseMaxTokensOverflowError,
  extractRetryAfter,
  is401Error,
  isConnectionError,
} from "./errors.ts";
import { shouldRetry529 } from "../llm/fallback.ts";

import type { FallbackConfig } from "../llm/fallback.ts";

// ─── 保留类型（兼容旧测试） ───

/** @deprecated 请使用 llm/fallback.ts 中的 FallbackConfig */
export interface RetryContext {
  /** max_tokens 溢出恢复时设置 */
  maxTokensOverride?: number;
  /** 当前使用的模型 */
  model: string;
  /** 是否需要禁用 keep-alive（ECONNRESET 后置位） */
  disableKeepAlive?: boolean;
  /** 是否需要刷新认证（401 后置位） */
  needsAuthRefresh?: boolean;
}

/** @deprecated 请使用 llm/fallback.ts 中的 FallbackConfig */
export interface RetryOptions {
  /** 最大重试次数（默认 10） */
  maxRetries?: number;
  /** 主模型 */
  model: string;
  /** 降级模型（存在时，连续 529 触发降级而非放弃） */
  fallbackModel?: string;
  /** 中断信号 */
  signal?: AbortSignal;
  /** 查询来源（前台/后台） */
  querySource?: import("../llm/fallback.ts").QuerySource;
  /** 预设的连续 529 计数（跨调用累积时使用） */
  initialConsecutive529Errors?: number;
  /** 上下文窗口大小（用于 max_tokens 溢出兜底计算，可选） */
  contextLimit?: number;
  /** 是否交互式（影响错误文案） */
  isInteractive?: boolean;
}

/** @deprecated 模型降级已由 fallback.ts 统一处理 */
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`模型降级: ${originalModel} → ${fallbackModel}`);
    this.name = "FallbackTriggeredError";
  }
}

/** @deprecated 不可重试错误已由 fallback.ts 统一处理 */
export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : String(originalError),
    );
    this.name = "CannotRetryError";
  }
}

// ─── 重试常量 ───

/** @deprecated 重试次数由 fallback.ts 各阶段配置决定 */
export const DEFAULT_MAX_RETRIES = 10;

/** @deprecated 529 计数由 fallback.ts 的 MAX_529_CONSECUTIVE 决定 */
export const MAX_529_RETRIES = 3;

// ─── 工具函数 ───

const MAX_DELAY_MS = 32_000;
const BASE_DELAY_MS = 500;
const SAFETY_BUFFER = 1_000;
const FLOOR_OUTPUT_TOKENS = 3_000;

/**
 * @deprecated 退避计算已吸收至 fallback.ts 的 calculateRetryDelay()
 */
export function getRetryDelay(
  attempt: number,
  retryAfterMs?: number,
  maxDelayMs = MAX_DELAY_MS,
  rng: () => number = Math.random,
): number {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs);
  const jitter = rng() * 0.25 * baseDelay;
  return Math.round(baseDelay + jitter);
}

/**
 * @deprecated max_tokens 溢出恢复已吸收至 fallback.ts 的 computeSafeMaxTokens()
 */
export function computeSafeMaxTokens(
  inputTokens: number,
  contextLimit: number,
): number | undefined {
  const available = Math.max(0, contextLimit - inputTokens - SAFETY_BUFFER);
  if (available < FLOOR_OUTPUT_TOKENS) return undefined;
  return Math.max(FLOOR_OUTPUT_TOKENS, available);
}

// ─── 系统 API 错误消息 ───

/** @deprecated 系统 API 错误消息类型，请使用 fallback.ts 的同名类型 */
export interface SystemAPIErrorMessage {
  type: "system_api_error";
  content: string;
  delayMs: number;
  attempt: number;
  maxRetries: number;
  category: string;
}

// ─── withRetry（保留完整实现以兼容旧测试） ───

/** 判断错误是否值得重试（瞬态错误） */
function isRetryableError(error: unknown): boolean {
  const category = classifyAPIError(error);
  return (
    category === "api_timeout" ||
    category === "rate_limit" ||
    category === "server_overload" ||
    category === "server_error" ||
    category === "connection_error"
  );
}

/** sleep，支持 abort 中断 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/**
 * @deprecated AsyncGenerator 重试引擎已废弃，请使用 fallback.ts 的 ModelFallback。
 *
 * 保留完整实现以兼容 tests/api/retry-engine.test.ts。
 */
export async function* withRetry<T>(
  operation: (attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const context: RetryContext = { model: options.model };
  let consecutive529 = options.initialConsecutive529Errors ?? 0;

  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    try {
      const result = await operation(attempt, context);
      context.maxTokensOverride = undefined;
      return result;
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        throw new RequestAbortedError("Request aborted");
      }

      const category = classifyAPIError(error);

      if (category === "server_overload") {
        consecutive529++;
      } else {
        consecutive529 = 0;
      }

      if (category === "server_overload" && !shouldRetry529(options.querySource)) {
        throw new CannotRetryError(error, context);
      }

      if (category === "server_overload" && consecutive529 >= MAX_529_RETRIES) {
        if (options.fallbackModel) {
          throw new FallbackTriggeredError(options.model, options.fallbackModel);
        }
        throw new CannotRetryError(error, context);
      }

      if (category === "prompt_too_long") {
        throw new CannotRetryError(error, context);
      }

      if (category === "max_tokens_overflow") {
        const overflow = parseMaxTokensOverflowError(error);
        const contextLimit = overflow?.contextLimit ?? options.contextLimit;
        if (overflow && contextLimit) {
          const safe = computeSafeMaxTokens(overflow.inputTokens, contextLimit);
          if (safe !== undefined) {
            context.maxTokensOverride = safe;
            continue;
          }
        }
        throw new CannotRetryError(error, context);
      }

      if (attempt > maxRetries) {
        throw new CannotRetryError(error, context);
      }

      if (is401Error(error)) {
        context.needsAuthRefresh = true;
        continue;
      }

      const code = getNetworkErrorCode(error);
      if ((code === "ECONNRESET" || code === "EPIPE") || (isConnectionError(error) && !context.disableKeepAlive)) {
        context.disableKeepAlive = true;
      }

      if (!isRetryableError(error)) {
        throw new CannotRetryError(error, context);
      }

      const retryAfterSec = extractRetryAfter(error);
      const delayMs = getRetryDelay(
        attempt,
        retryAfterSec ? retryAfterSec * 1000 : undefined,
      );
      const userMsg = getErrorMessageForUser(error, options.model, {
        isInteractive: options.isInteractive,
      });

      yield {
        type: "system_api_error",
        content: userMsg.content,
        delayMs,
        attempt,
        maxRetries,
        category,
      };

      await sleep(delayMs, options.signal);
    }
  }
}
