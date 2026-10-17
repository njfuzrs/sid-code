/**
 * 卡 G1（2026-10-14）哨兵：子代理漏斗**有**单次尝试上限，且扣休眠。
 *
 * 排查事故 20261014-110202 时曾有人提议「子代理没有首字节超时，加一道 30–60s」——不成立：
 * 子代理走 streamWithResilience，单次尝试上限 = 主循环同一个 `fallbackStreamTimeoutMs`
 * （2026-10-17 PR-B 起；此前是 subAgent 档 180s），fallback 用 createSleepAwareDeadline 判定（事故日志「已剔除 181s 休眠，距真正到期
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
import { DEFAULTS as NETWORK_DEFAULTS } from "@sid-code/core/config/network-profile.ts";

describe("G1 — 子代理单次尝试上限（与主循环同源）", () => {
  // PR-B（2026-10-17）：子代理与主循环同源，不再吃 side-call 的 180s 缺省档。
  // 源码断言而非行为断言：漏掉 `streamTimeoutMs:` 那一行时子代理会静默回落 180s，
  // 行为上只表现为「慢一点的上游偶尔被提前重发」，没有别的测试会红（方案 T7）。
  test.each([
    ["agentic-loop 主轮 + 总结轮", "../../src/agent/agentic-loop.ts", 2],
    ["spawn 子进程", "../../../cli/src/entrypoints/headless.ts", 1],
  ])("%s 显式传 fallbackStreamTimeoutMs", (_label, rel, n) => {
    const src = readFileSync(join(import.meta.dir, rel), "utf8");
    expect(src.match(/streamTimeoutMs: (netTimeouts|net)\.fallbackStreamTimeoutMs/g)?.length).toBe(
      n,
    );
  });

  test("side-call 缺省档仍是 180s，且严格短于子代理所用的主循环档", () => {
    expect(DEFAULT_SIDE_STREAM_TIMEOUT_MS).toBe(180_000);
    expect(resolveSideStreamTimeoutMs()).toBe(180_000);
    expect(NETWORK_DEFAULTS.fallbackStreamTimeoutMs).toBeGreaterThan(
      DEFAULT_SIDE_STREAM_TIMEOUT_MS,
    );
  });

  test("fallback 流超时判据扣休眠（createSleepAwareDeadline + 重排而非开枪）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/llm/fallback.ts"), "utf8");
    expect(src).toMatch(/const streamDeadline = createSleepAwareDeadline\(streamTimeoutMs\)/);
    expect(src).toMatch(
      /const remaining = streamDeadline\.remainingMs\(\);\s*if \(remaining > 0\)/,
    );
  });
});
