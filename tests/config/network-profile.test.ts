/**
 * network-profile：统一超时/重试配置解析 — 单元测试
 *
 * 验证三层优先级链（env override > settings.network > 统一默认值）与退避算法。
 * 重点保证：只有一套默认值（不分 direct/gateway、不按模型分档），
 * 且各覆盖层级互不串味。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  DEFAULTS,
  resolveLoopTimeouts,
  resolveHeaderTimeoutMs,
  computeBackoffMs,
} from "../../src/config/network-profile.ts";

const ENV_KEYS = [
  "SID_CODE_RESPONSE_HEADER_TIMEOUT_MS",
  "SID_CODE_WATCHDOG_CHECK_INTERVAL_MS",
  "SID_CODE_WATCHDOG_NO_PROGRESS_MS",
  "SID_CODE_WATCHDOG_HEADER_GRACE_MS",
  "SID_CODE_MAX_TURN_DURATION_MS",
  "SID_CODE_MAX_TIMEOUT_RETRIES",
  "SID_CODE_RETRY_BACKOFF_BASE_MS",
  "SID_CODE_RETRY_BACKOFF_MAX_MS",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("resolveLoopTimeouts — 层级优先级", () => {
  test("无任何覆盖 → 全部取统一默认值", () => {
    const t = resolveLoopTimeouts({});
    expect(t).toEqual({ ...DEFAULTS });
  });

  test("settings.network 覆盖默认值", () => {
    const t = resolveLoopTimeouts({
      network: { headerTimeoutMs: 111_000, maxTimeoutRetries: 7 },
    });
    expect(t.headerTimeoutMs).toBe(111_000);
    expect(t.maxTimeoutRetries).toBe(7);
    // 未覆盖字段仍取默认值
    expect(t.watchdogNoProgressMs).toBe(DEFAULTS.watchdogNoProgressMs);
  });

  test("环境变量优先级高于 settings.network", () => {
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "222000";
    const t = resolveLoopTimeouts({ network: { headerTimeoutMs: 111_000 } });
    expect(t.headerTimeoutMs).toBe(222_000);
  });

  test("非法环境变量（负数/非数字）被忽略，回退下一层", () => {
    process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "-1";
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "abc";
    const t = resolveLoopTimeouts({ network: { maxTimeoutRetries: 3 } });
    expect(t.maxTimeoutRetries).toBe(3); // settings 生效
    expect(t.headerTimeoutMs).toBe(DEFAULTS.headerTimeoutMs); // 回退默认
  });

  test("maxTimeoutRetries=0 是合法值（nonNegative），不被当作未设置", () => {
    process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "0";
    const t = resolveLoopTimeouts({});
    expect(t.maxTimeoutRetries).toBe(0);
  });

  test("统一默认值：保活优先（阈值足够宽）", () => {
    const t = resolveLoopTimeouts({});
    // 回归保护：这些是与用户对齐的"宁可多等不无声杀"的下限，不应被悄悄调小。
    expect(t.headerTimeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(t.watchdogNoProgressMs).toBeGreaterThanOrEqual(300_000);
    expect(t.maxTurnDurationMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(t.maxTimeoutRetries).toBeGreaterThanOrEqual(4);
    expect(t.retryBackoffBaseMs).toBeGreaterThan(0); // 不再零延迟重试
  });
});

describe("resolveHeaderTimeoutMs — provider 内部两层", () => {
  test("默认取统一 header 超时", () => {
    expect(resolveHeaderTimeoutMs()).toBe(DEFAULTS.headerTimeoutMs);
  });
  test("环境变量覆盖", () => {
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "99000";
    expect(resolveHeaderTimeoutMs()).toBe(99_000);
  });
});

describe("computeBackoffMs — 指数退避 + jitter + 封顶", () => {
  test("随 attempt 指数增长（含 ±15% jitter，取区间断言）", () => {
    // attempt=0: base*1；attempt=1: base*2；attempt=2: base*4
    const base = 1_000;
    const max = 100_000;
    const a0 = computeBackoffMs(0, base, max);
    const a2 = computeBackoffMs(2, base, max);
    expect(a0).toBeGreaterThanOrEqual(Math.round(1_000 * 0.85));
    expect(a0).toBeLessThanOrEqual(Math.round(1_000 * 1.15));
    expect(a2).toBeGreaterThanOrEqual(Math.round(4_000 * 0.85));
    expect(a2).toBeLessThanOrEqual(Math.round(4_000 * 1.15));
  });

  test("封顶 maxMs（含 jitter 上界）", () => {
    const capped = computeBackoffMs(20, 1_000, 5_000); // 1000*2^20 远超 5000
    expect(capped).toBeLessThanOrEqual(Math.round(5_000 * 1.15));
    expect(capped).toBeGreaterThanOrEqual(Math.round(5_000 * 0.85));
  });
});
