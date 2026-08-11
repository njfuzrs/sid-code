/**
 * 重试退避延迟计算 — 主路径（fallback.ts）与子代理路径（agentic-loop.ts）的共享实现。
 *
 * 背景（事故 session 20260730-183103-5e334145）：
 * 全部重试/退避逻辑此前只存在于 ModelFallback 内部，而子代理走
 * `provider.sendMessageStream()` 直连，**完全绕过** fallback 引擎 —— 结果一次 429
 * 就让子代理立即失败（实测 429 到 SubagentStop 间隔 1ms，零重试）。
 *
 * 修复时把延迟计算抽到这里，而不是在 agentic-loop 里另写一份：两份平行实现必然漂移
 * （fallback.ts 顶部注释里已记录过一轮「两阶段 maxDelayMs 架空统一配置」的同型事故）。
 * 语义与 ModelFallback.calculateRetryDelay 完全一致，fallback.ts 现委托到此处。
 */

import {
  RetryableError,
  TerminalError,
  parseRateLimitReset,
  parseRetryAfterFromHeaders,
} from "./errors.ts";
import { computeBackoffMs, DEFAULTS as NETWORK_DEFAULTS } from "../config/network-profile.ts";

/** 退避延迟上限（用于封顶服务端 Retry-After / rate-limit-reset）。
 *  与 network-profile.retryBackoffMaxMs 对齐：服务端明确要求的更长等待（如限流 60s）
 *  不应被截断到更小值，否则会提前重试撞在仍未恢复的服务上。 */
export const MAX_DELAY_MS = 120_000;

export interface BackoffOptions {
  /** 本阶段延迟上限（连接/流式两阶段各自更紧的上限） */
  maxDelayMs: number;
  /** 退避基数，缺省走 network-profile 的 retryBackoffBaseMs */
  retryBackoffBaseMs?: number;
  /** 退避上限，缺省走 network-profile 的 retryBackoffMaxMs */
  retryBackoffMaxMs?: number;
}

/**
 * 计算重试延迟。
 *
 * 优先级：服务端 Retry-After header > RetryableError.retryAfterMs >
 *         rate-limit-reset header > 指数退避 + jitter
 *
 * 限流（rate_limit）用 +20% 单向正抖动而非 ±15% 双向：双向抖动可能算出比服务端
 * 最小间隔更短的延迟，重试直接再撞一次限流。
 */
export function calculateRetryDelay(
  err: unknown,
  attempt: number,
  classified: TerminalError | RetryableError | Error,
  opts: BackoffOptions,
): number {
  // 1. 服务端明确指定的 Retry-After（headers 优先）
  const retryAfterMs = parseRetryAfterFromHeaders(err);
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_DELAY_MS);

  // 2. RetryableError 携带的 retryAfterMs
  if (classified instanceof RetryableError && classified.retryAfterMs && classified.retryAfterMs > 0) {
    return Math.min(classified.retryAfterMs, MAX_DELAY_MS);
  }

  // 3. rate-limit-reset header：计算等待到 reset 时刻的延迟
  const resetTime = parseRateLimitReset(err);
  if (resetTime) {
    const waitMs = Math.max(0, resetTime - Date.now());
    if (waitMs > 0 && waitMs <= MAX_DELAY_MS) return waitMs;
  }

  // 4. 指数退避。上限取「本阶段 maxDelayMs 与注入 retryBackoffMaxMs 的较小者」，
  //    既保留两阶段各自更紧的上限，又受统一配置约束。
  const baseMs = opts.retryBackoffBaseMs ?? NETWORK_DEFAULTS.retryBackoffBaseMs;
  const cappedMaxMs = Math.min(
    opts.maxDelayMs,
    opts.retryBackoffMaxMs ?? NETWORK_DEFAULTS.retryBackoffMaxMs,
  );
  const isRateLimit = classified instanceof RetryableError && classified.reason === "rate_limit";

  if (isRateLimit) {
    // 限流：+20% 正向抖动（尊重服务器最小延迟，不用双向 jitter 以免早于服务器最小延迟）
    const baseDelay = Math.min(baseMs * Math.pow(2, attempt), cappedMaxMs);
    const jitter = baseDelay * 0.2 * Math.random();
    return Math.round(baseDelay + jitter);
  }

  // 其他错误：指数退避 + ±15% 双向 jitter，与 loop 层退避同一实现
  return computeBackoffMs(attempt, baseMs, cappedMaxMs);
}
