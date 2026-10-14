/**
 * 卡 B2（2026-10-14）：子代理墙钟 / 硬 kill 扣休眠。
 *
 * 事故 20261014-110202-8c0ffb30：子代理干活约 3.5 分钟 + 休眠 181s，唤醒瞬间裸
 * setTimeout(300s) 补发 → detach。这里用假时钟复现：挂钟走满 300s 但其中 181s 是休眠，
 * 定时器不得开枪；有效时长真的满 300s 才开枪。
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { armSleepAwareTimer } from "@sid-code/core/agent/sleep-aware-timer.ts";
import {
  getSleepLedger,
  __resetSleepLedgerForTest,
  isSleepObserverRunning,
} from "@sid-code/shared/utils/sleep-detect.ts";

const SLEPT_MS = 181_000;

/** 模拟一次休眠被观测器记账（record 的语义：tick 迟到 = 休眠） */
function injectSleep(ms: number): void {
  getSleepLedger().record(ms + 5_000, 5_000);
}

beforeEach(() => {
  __resetSleepLedgerForTest();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  __resetSleepLedgerForTest();
});

describe("armSleepAwareTimer", () => {
  test("墙钟 300s，第 200s 注入 181s 休眠：挂钟到 300s 不开枪，有效满 300s 才开枪", () => {
    let fired = 0;
    armSleepAwareTimer(300_000, () => fired++);
    jest.advanceTimersByTime(200_000);
    injectSleep(SLEPT_MS);
    jest.advanceTimersByTime(100_000); // 挂钟 300s
    expect(fired).toBe(0);
    jest.advanceTimersByTime(SLEPT_MS - 1_000);
    expect(fired).toBe(0);
    jest.advanceTimersByTime(1_000); // 挂钟 481s = 有效 300s
    expect(fired).toBe(1);
  });

  test("硬 kill 档（2× timeout）同样扣休眠", () => {
    let fired = 0;
    armSleepAwareTimer(600_000, () => fired++);
    jest.advanceTimersByTime(100_000);
    injectSleep(SLEPT_MS);
    jest.advanceTimersByTime(500_000);
    expect(fired).toBe(0);
    jest.advanceTimersByTime(SLEPT_MS);
    expect(fired).toBe(1);
  });

  test("无休眠时准点开枪（负向对照：防「定时器本来就不开枪」的空集全绿）", () => {
    let fired = 0;
    armSleepAwareTimer(300_000, () => fired++);
    jest.advanceTimersByTime(299_999);
    expect(fired).toBe(0);
    jest.advanceTimersByTime(1);
    expect(fired).toBe(1);
  });

  test("持有休眠观测器直到 fire / cancel（否则账本没人记）", () => {
    const t = armSleepAwareTimer(300_000, () => {});
    expect(isSleepObserverRunning()).toBe(true);
    t.cancel();
    expect(isSleepObserverRunning()).toBe(false);
    t.cancel(); // 幂等
  });

  test("cancel 后不再开枪", () => {
    let fired = 0;
    const t = armSleepAwareTimer(1_000, () => fired++);
    t.cancel();
    jest.advanceTimersByTime(5_000);
    expect(fired).toBe(0);
  });
});

describe("两条子代理路径都走同一个工具函数（防一处漏改）", () => {
  test("sub-agent.ts 不再有裸 setTimeout 墙钟 / 硬 kill", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf8").replace(
      /\/\/.*$/gm,
      "",
    );
    // 内置 + 自定义 各一对（墙钟 + 硬 kill）
    expect([...src.matchAll(/armSleepAwareTimer\(/g)].length).toBe(4);
    expect(src).not.toMatch(/hardKillTimer = setTimeout/);
    expect(src).not.toMatch(/const timer = setTimeout\(\(\) => \{\s*detached = true/);
  });
});
