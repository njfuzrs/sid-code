/**
 * AsyncGenerator 驱动的重试引擎
 *
 * 职责（对标 Claude Code 的 withRetry.ts）：
 * - 通过 yield 向 UI 层报告重试进度（"API 过载，5 秒后重试 (3/10)"）
 * - 前台 / 后台查询差异化重试（后台查询遇到 529 立即放弃，避免重试风暴）
 * - 529 连续 N 次 → 触发模型降级（FallbackTriggeredError）
 * - max_tokens 溢出自动计算安全值并重试
 * - ECONNRESET → 标记需要禁用 keep-alive 并重试
 * - 401 → 触发认证刷新并重试
 * - prompt too long → 不重试，抛出特殊错误供上层触发响应式压缩
 *
 * 设计为通用 AsyncGenerator，不直接耦合 Provider，便于单测与复用。
 */

import { isAbortError, RequestAbortedError } from "../llm/errors.ts";
import {
  classifyAPIError,
  getErrorMessageForUser,
  parseMaxTokensOverflowError,
  extractRetryAfter,
  is401Error,
  isConnectionError,
} from "./errors.ts";
import { getNetworkErrorCode } from "../llm/errors.ts";

/** 查询来源分类 */
export type QuerySource =
  | "main_thread" // 用户主对话（前台）
  | "agent" // 子代理（前台）
  | "compact" // 上下文压缩（前台）
  | "summary" // 摘要生成（后台）
  | "title" // 标题生成（后台）
  | "classifier"; // 分类器（后台）

/** 前台查询源 — 用户正在等待结果，529 时重试 */
export const FOREGROUND_SOURCES = new Set<QuerySource>([
  "main_thread",
  "agent",
  "compact",
]);

/** 重试常量 */
export const DEFAULT_MAX_RETRIES = 10;
export const MAX_529_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const SAFETY_BUFFER = 1_000;
const FLOOR_OUTPUT_TOKENS = 3_000;

/** 重试上下文 — 在重试过程中可被修改并回传给 operation */
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

/** 重试配置 */
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
  querySource?: QuerySource;
  /** 预设的连续 529 计数（跨调用累积时使用） */
  initialConsecutive529Errors?: number;
  /** 上下文窗口大小（用于 max_tokens 溢出兜底计算，可选） */
  contextLimit?: number;
  /** 是否交互式（影响错误文案） */
  isInteractive?: boolean;
}

/** 系统 API 错误消息 — yield 给 UI 层显示 */
export interface SystemAPIErrorMessage {
  type: "system_api_error";
  /** 用户可读的错误描述 */
  content: string;
  /** 等待时间（毫秒） */
  delayMs: number;
  /** 当前尝试次数（1-based） */
  attempt: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 错误分类标签 */
  category: string;
}

/** 模型降级触发错误 */
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`模型降级: ${originalModel} → ${fallbackModel}`);
    this.name = "FallbackTriggeredError";
  }
}

/** 不可重试错误 */
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

/** 后台查询遇到 529 时是否仍重试 */
export function shouldRetry529(querySource?: QuerySource): boolean {
  return querySource === undefined || FOREGROUND_SOURCES.has(querySource);
}

/**
 * 计算退避延迟。
 * - 优先使用服务端指定的 Retry-After
 * - 否则指数退避 + 25% 抖动
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
 * 计算 max_tokens 溢出后的安全 max_tokens 值。
 * 返回 undefined 表示可用空间太小，无法恢复。
 */
export function computeSafeMaxTokens(
  inputTokens: number,
  contextLimit: number,
): number | undefined {
  const available = Math.max(0, contextLimit - inputTokens - SAFETY_BUFFER);
  if (available < FLOOR_OUTPUT_TOKENS) return undefined;
  return Math.max(FLOOR_OUTPUT_TOKENS, available);
}

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
 * AsyncGenerator 驱动的重试引擎。
 *
 * - yield SystemAPIErrorMessage 给 UI 层显示重试进度
 * - return T 表示操作成功
 * - throw CannotRetryError / FallbackTriggeredError / RequestAbortedError 表示最终失败
 *
 * operation 接收 (attempt, context)，从 context 读取 maxTokensOverride 等动态调整。
 */
export async function* withRetry<T>(
  operation: (attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const context: RetryContext = { model: options.model };
  let consecutive529 = options.initialConsecutive529Errors ?? 0;

  for (let attempt = 1; ; attempt++) {
    // 每次尝试前清除一次性标志由调用方在 operation 内消费
    if (options.signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    try {
      const result = await operation(attempt, context);
      // 成功后清除一次性标志
      context.maxTokensOverride = undefined;
      return result;
    } catch (error) {
      // ── 用户中止：不重试 ──
      if (options.signal?.aborted || isAbortError(error)) {
        throw new RequestAbortedError("Request aborted");
      }

      const category = classifyAPIError(error);

      // ── 529 计数维护 ──
      if (category === "server_overload") {
        consecutive529++;
      } else {
        consecutive529 = 0;
      }

      // ── 529 + 非前台查询：立即放弃（避免重试风暴放大） ──
      if (category === "server_overload" && !shouldRetry529(options.querySource)) {
        throw new CannotRetryError(error, context);
      }

      // ── 529 连续达上限：降级或放弃 ──
      if (category === "server_overload" && consecutive529 >= MAX_529_RETRIES) {
        if (options.fallbackModel) {
          throw new FallbackTriggeredError(options.model, options.fallbackModel);
        }
        throw new CannotRetryError(error, context);
      }

      // ── prompt too long：不重试，交上层响应式压缩 ──
      // （注意：max_tokens_overflow 不在此分支，它可自动恢复）
      if (category === "prompt_too_long") {
        throw new CannotRetryError(error, context);
      }

      // ── max_tokens 溢出：计算安全值后重试（不消耗 attempt 退避） ──
      if (category === "max_tokens_overflow") {
        const overflow = parseMaxTokensOverflowError(error);
        const contextLimit = overflow?.contextLimit ?? options.contextLimit;
        if (overflow && contextLimit) {
          const safe = computeSafeMaxTokens(overflow.inputTokens, contextLimit);
          if (safe !== undefined) {
            context.maxTokensOverride = safe;
            continue; // 立即用调整后的 max_tokens 重试
          }
        }
        // 无法恢复
        throw new CannotRetryError(error, context);
      }

      // ── 超过最大重试次数 ──
      if (attempt > maxRetries) {
        throw new CannotRetryError(error, context);
      }

      // ── 401：刷新认证后重试 ──
      if (is401Error(error)) {
        context.needsAuthRefresh = true;
        // 认证刷新不退避，直接重试一次
        continue;
      }

      // ── ECONNRESET / EPIPE：禁用 keep-alive 后重试 ──
      const code = getNetworkErrorCode(error);
      if ((code === "ECONNRESET" || code === "EPIPE") || (isConnectionError(error) && !context.disableKeepAlive)) {
        context.disableKeepAlive = true;
        // 连接重置：短暂退避后重试
      }

      // ── 不可重试错误：放弃 ──
      if (!isRetryableError(error)) {
        throw new CannotRetryError(error, context);
      }

      // ── 可重试：计算延迟，yield 进度，等待 ──
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
