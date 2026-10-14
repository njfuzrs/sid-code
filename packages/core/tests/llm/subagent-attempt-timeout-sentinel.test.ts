/**
 * 卡 G1（2026-10-14）哨兵：子代理漏斗**有**单次尝试上限，且扣休眠。
 *
 * 排查事故 20261014-110202 时曾有人提议「子代理没有首字节超时，加一道 30–60s」——不成立：
 * 子代理走 streamWithResilience，单次尝试上限 = LIFECYCLE_PRESETS.subAgent.overallTimeoutMs
 * (180s)，fallback 用 createSleepAwareDeadline 判定（事故日志「已剔除 181s 休眠，距真正到期
 * 还有 162s」就是它）。30–60s 会大量误杀健康请求（本机 2387 个请求 TTFB p95 107s / p99 178s）。
 * 本文件钉住这两条事实，防止有人再叠一层同值同谓词的超时。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_SIDE_STREAM_TIMEOUT_MS,
  resolveSideStreamTimeoutMs,
} from "@sid-code/core/llm/resilient-stream.ts";
import { LIFECYCLE_PRESETS } from "@sid-code/core/llm/stream-lifecycle.ts";

describe("G1 — 子代理单次尝试上限", () => {
  test("= LIFECYCLE_PRESETS.subAgent.overallTimeoutMs = 180s", () => {
    expect(LIFECYCLE_PRESETS.subAgent.overallTimeoutMs).toBe(180_000);
    expect(DEFAULT_SIDE_STREAM_TIMEOUT_MS).toBe(LIFECYCLE_PRESETS.subAgent.overallTimeoutMs);
    expect(resolveSideStreamTimeoutMs()).toBe(180_000);
  });

  test("fallback 流超时判据扣休眠（createSleepAwareDeadline + 重排而非开枪）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/llm/fallback.ts"), "utf8");
    expect(src).toMatch(/const streamDeadline = createSleepAwareDeadline\(streamTimeoutMs\)/);
    expect(src).toMatch(
      /const remaining = streamDeadline\.remainingMs\(\);\s*if \(remaining > 0\)/,
    );
  });
});
