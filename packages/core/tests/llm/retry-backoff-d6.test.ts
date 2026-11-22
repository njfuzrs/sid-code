/**
 * D6 回归门禁 —— 限流退避的「上限」必须是硬上限。
 *
 * 修复前：`baseDelay` 先被钳到 `cappedMaxMs`，jitter（最多 +20%）加在钳制**之后**，
 * 于是指数一触顶，每次等待仍会多出 0~20%：配置上限 120s 时实测可达 144s。
 * 消费者（`recovery-policy` 的 S3 deadline、`retry_budget_exhausted` 的
 * `wantedDelayMs`）按上限估算时间预算，超出部分会被误算成「还有余量」。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { calculateRetryDelay } from "@sid-code/core/llm/retry-backoff.ts";

const err = new Error("429 Too Many Requests");

describe("D6：限流退避的 jitter 不得突破上限", () => {
  test("指数触顶后，200 次采样恒等于上限（不是「约等于」）", () => {
    const opts = { maxDelayMs: 120_000, retryBackoffBaseMs: 5_000, retryBackoffMaxMs: 120_000 };
    for (let i = 0; i < 200; i++) {
      const delay = calculateRetryDelay(err, 10, { reason: "rate_limit" }, opts);
      expect(delay).toBeLessThanOrEqual(120_000);
      // 触顶后基准就是上限，抖动只会往上加 —— 修复后必须被压回上限本身。
      expect(delay).toBe(120_000);
    }
  });

  test("未触顶时 +20% 抖动仍然生效（不是把抖动整个删掉）", () => {
    const opts = { maxDelayMs: 120_000, retryBackoffBaseMs: 1_000, retryBackoffMaxMs: 120_000 };
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const delay = calculateRetryDelay(err, 0, { reason: "rate_limit" }, opts);
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(1_200);
      seen.add(delay);
    }
    // 50 次全部落在同一个整数上的概率可忽略；断言抖动没有被误删。
    expect(seen.size).toBeGreaterThan(1);
  });

  test("上限取 maxDelayMs 与 retryBackoffMaxMs 的较小者", () => {
    const opts = { maxDelayMs: 2_000, retryBackoffBaseMs: 5_000, retryBackoffMaxMs: 120_000 };
    for (let i = 0; i < 50; i++) {
      const delay = calculateRetryDelay(err, 10, { reason: "rate_limit" }, opts);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
  });
});
