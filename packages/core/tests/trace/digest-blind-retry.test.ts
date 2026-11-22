/**
 * D7 回归门禁 —— 白撞率的口径必须能被聚合出来。
 *
 * 「白撞」= 服务端明确要求了最小等待，我们实际等的比它短，等于在限流窗口内
 * 又打了一发。要判断 `retryBackoffBaseMs: 5000` 是否合理，必须先有这个比率；
 * 没有它，「5s 是不是太大/太小」只能靠猜。
 *
 * 本用例守住三件事：
 *   ① 分子分母同源（`delayMs` vs `retryAfterMs`）；
 *   ② 服务端没表态的重试**不进分母**（否则比率被稀释）；
 *   ③ 分母为 0 时字段不落（「无样本」≠「0% 白撞」）。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { aggregateProviderStats } from "@sid-code/core/trace/digest.ts";

function retryEvent(data: Record<string, unknown>) {
  return { event: "RetryTelemetry", data: { type: "retry", provider: "p1", ...data } };
}

describe("D7：限流白撞率聚合", () => {
  test("delayMs < retryAfterMs → 计入白撞", () => {
    const stats = aggregateProviderStats([retryEvent({ retryAfterMs: 10_000, delayMs: 5_000 })]);
    expect(stats[0].retried).toBe(1);
    expect(stats[0].serverWaitRetries).toBe(1);
    expect(stats[0].blindRetries).toBe(1);
    expect(stats[0].blindRetryRatio).toBe(1);
  });

  test("delayMs ≥ retryAfterMs → 不算白撞", () => {
    const stats = aggregateProviderStats([retryEvent({ retryAfterMs: 10_000, delayMs: 12_000 })]);
    expect(stats[0].serverWaitRetries).toBe(1);
    expect(stats[0].blindRetries).toBe(0);
    expect(stats[0].blindRetryRatio).toBe(0);
  });

  test("没有 retryAfterMs 的重试只计入 retried，不进白撞率分母", () => {
    const stats = aggregateProviderStats([
      retryEvent({ delayMs: 5_000 }),
      retryEvent({ retryAfterMs: 10_000, delayMs: 12_000 }),
    ]);
    expect(stats[0].retried).toBe(2);
    expect(stats[0].serverWaitRetries).toBe(1);
    expect(stats[0].blindRetries).toBe(0);
    expect(stats[0].blindRetryRatio).toBe(0);
  });

  test("分母为 0 时不落字段（避免把「无样本」读成「0% 白撞」）", () => {
    const stats = aggregateProviderStats([retryEvent({ delayMs: 5_000 })]);
    expect(stats[0].serverWaitRetries).toBeUndefined();
    expect(stats[0].blindRetries).toBeUndefined();
    expect(stats[0].blindRetryRatio).toBeUndefined();
  });

  test("retryAfterMs = 0 视为服务端没有明确要求", () => {
    const stats = aggregateProviderStats([retryEvent({ retryAfterMs: 0, delayMs: 0 })]);
    expect(stats[0].serverWaitRetries).toBeUndefined();
  });

  test("混合样本：比率 = 白撞数 / 有要求数（分母不含无要求样本）", () => {
    const stats = aggregateProviderStats([
      retryEvent({ retryAfterMs: 10_000, delayMs: 5_000 }), // 白撞
      retryEvent({ retryAfterMs: 10_000, delayMs: 12_000 }), // 等够了
      retryEvent({ retryAfterMs: 20_000, delayMs: 6_000 }), // 白撞
      retryEvent({ delayMs: 5_000 }), // 无要求，不进分母
    ]);
    expect(stats[0].retried).toBe(4);
    expect(stats[0].serverWaitRetries).toBe(3);
    expect(stats[0].blindRetries).toBe(2);
    expect(stats[0].blindRetryRatio).toBeCloseTo(2 / 3);
  });
});
