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

import { parseRateLimitReset, parseRetryAfterFromHeaders } from "./errors.ts";

/**
 * 退避需要的那点分类信息：细分原因（只用来认 rate_limit）与服务端建议等待。
 * 2026-10-08 起由 `error-normalize.ts` 的归一化结果提供，不再依赖错误类实例。
 */
export interface BackoffHint {
  reason?: string;
  retryAfterMs?: number;
}
import { computeBackoffMs, DEFAULTS as NETWORK_DEFAULTS } from "../config/network-profile.ts";

/** 退避延迟上限（用于封顶服务端 Retry-After / rate-limit-reset）。
 *  与 network-profile.retryBackoffMaxMs 对齐：服务端明确要求的更长等待（如限流 60s）
 *  不应被截断到更小值，否则会提前重试撞在仍未恢复的服务上。 */
export const MAX_DELAY_MS = 120_000;

/**
 * D7（2026-11-22）：取服务端**明确要求**的等待时长（毫秒），没有明确要求返回 undefined。
 *
 * 三条来源与 {@link calculateRetryDelay} 同序：
 *   ① Retry-After header > ② 归一化阶段的 retryAfterMs > ③ rate-limit-reset header。
 * 顺序必须一致，否则「按 A 判定能不能等」与「按 B 实际睡多久」会自相矛盾。
 *
 * 为什么要抽成共享实现：恢复决策（`recovery-policy`：等不起 → give_up）、退避计算
 * （本文件）、白撞率归因（`fallback` 的 retry 遥测）三处要用同一个口径。
 * 三份平行实现必然漂移——本文件顶部那条「两份平行实现必然漂移」的教训同样适用。
 *
 * @param raw 原始错误（`parseRetryAfterFromHeaders` / `parseRateLimitReset` 的入参）
 * @param normalizedRetryAfterMs 归一化阶段已解析出的建议等待（`NormalizedLLMError.retryAfterMs`）
 * @param now 当前时刻（测试注入用；rate-limit-reset 是绝对时刻，需要基准）
 */
export function serverRequestedWaitMs(
  raw: unknown,
  normalizedRetryAfterMs?: number,
  now = Date.now(),
): number | undefined {
  const fromHeaders = parseRetryAfterFromHeaders(raw);
  if (fromHeaders && fromHeaders > 0) return fromHeaders;
  if (normalizedRetryAfterMs && normalizedRetryAfterMs > 0) return normalizedRetryAfterMs;
  const resetAt = parseRateLimitReset(raw);
  if (resetAt) {
    const waitMs = Math.max(0, resetAt - now);
    if (waitMs > 0) return waitMs;
  }
  return undefined;
}

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
 * 优先级：服务端 Retry-After header > 归一化的 retryAfterMs >
 *         rate-limit-reset header > 指数退避 + jitter
 *
 * 限流（rate_limit）用 +20% 单向正抖动而非 ±15% 双向：双向抖动可能算出比服务端
 * 最小间隔更短的延迟，重试直接再撞一次限流。
 */
export function calculateRetryDelay(
  err: unknown,
  attempt: number,
  classified: BackoffHint,
  opts: BackoffOptions,
): number {
  // 1. 服务端明确指定的 Retry-After（headers 优先）
  const retryAfterMs = parseRetryAfterFromHeaders(err);
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_DELAY_MS);

  // 2. 归一化阶段解析出的 retryAfterMs
  if (classified.retryAfterMs && classified.retryAfterMs > 0) {
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
  const isRateLimit = classified.reason === "rate_limit";

  if (isRateLimit) {
    // 限流：+20% 正向抖动（尊重服务器最小延迟，不用双向 jitter 以免早于服务器最小延迟）
    const baseDelay = Math.min(baseMs * Math.pow(2, attempt), cappedMaxMs);
    const jitter = baseDelay * 0.2 * Math.random();
    // D6（2026-11-22）：jitter **必须**在加完之后再钳一次。原来只在乘指数后钳 `baseDelay`，
    // 抖动加在钳制之后，指数一旦触顶，每次等待仍会多出 0~20% —— 配置上限 120s 时实测
    // 可达 144s，「上限」不是硬上限。消费者按 retryBackoffMaxMs 估算时间预算
    // （`recovery-policy` 的 S3 deadline、`retry_budget_exhausted` 的 wantedDelayMs），
    // 超出部分会被算成「还有余量」，进而多睡一段本不该睡的退避。
    return Math.round(Math.min(baseDelay + jitter, cappedMaxMs));
  }

  // 其他错误：指数退避 + ±15% 双向 jitter，与 loop 层退避同一实现
  return computeBackoffMs(attempt, baseMs, cappedMaxMs);
}
