/**
 * 休眠感知单测（事故 20260801-175042-699f69f8 回归）
 *
 * 覆盖：挂钟跳跃判定阈值（倍数 + 绝对下限）、剔除时长口径、会话账本累计与去重、
 *      用户可见文案。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  isSleepGap,
  sleepGapMs,
  getSleepLedger,
  describeSleep,
  __resetSleepLedgerForTest,
  SLEEP_DETECT_RATIO,
  SLEEP_DETECT_FLOOR_MS,
} from "../../src/utils/sleep-detect.ts";

beforeEach(() => {
  __resetSleepLedgerForTest();
});

describe("isSleepGap — 判定阈值", () => {
  test("正常 tick 不算休眠", () => {
    expect(isSleepGap(5_000, 5_000)).toBe(false);
    expect(isSleepGap(5_200, 5_000)).toBe(false);
  });

  test("常见调度抖动（迟到几百毫秒到数秒）不算休眠", () => {
    // 这是最重要的负向用例：阈值定太松会把 GC / 事件循环短暂占满误判成休眠，
    // 进而无限重置重试预算——那比不检测更糟。
    expect(isSleepGap(5_500, 5_000)).toBe(false);
    expect(isSleepGap(10_000, 5_000)).toBe(false);
    expect(isSleepGap(29_000, 5_000)).toBe(false);
  });

  test("真实休眠量级（900s+）判为休眠", () => {
    // 事故实测值：预期 5000ms，实际 926241ms
    expect(isSleepGap(926_241, 5_000)).toBe(true);
  });

  test("绝对下限兜底：极小 tick 间隔下不因倍数达标就误判", () => {
    // 50ms × 10 = 500ms 是荒谬阈值；必须由 FLOOR 拦住。
    expect(isSleepGap(600, 50)).toBe(false);
    expect(isSleepGap(SLEEP_DETECT_FLOOR_MS - 1, 50)).toBe(false);
    expect(isSleepGap(SLEEP_DETECT_FLOOR_MS + 1, 50)).toBe(true);
  });

  test("倍数阈值：大 tick 间隔下由 RATIO 主导", () => {
    const expected = 10_000; // 10s tick → RATIO 阈值 100s，高于 FLOOR
    expect(isSleepGap(expected * SLEEP_DETECT_RATIO - 1, expected)).toBe(false);
    expect(isSleepGap(expected * SLEEP_DETECT_RATIO + 1, expected)).toBe(true);
  });

  test("非法输入不判为休眠（防御）", () => {
    expect(isSleepGap(NaN, 5_000)).toBe(false);
    expect(isSleepGap(100_000, 0)).toBe(false);
    expect(isSleepGap(100_000, -1)).toBe(false);
    expect(isSleepGap(Infinity, 5_000)).toBe(false);
  });
});

describe("sleepGapMs — 剔除时长口径", () => {
  test("只剔除超出预期的部分，不剔除那一个正常 tick 周期", () => {
    // 口径依据：那一个 tick 周期本来就该算进业务耗时，连它一起扣会让判据偏松。
    expect(sleepGapMs(926_241, 5_000)).toBe(921_241);
  });

  test("未达阈值返回 0", () => {
    expect(sleepGapMs(6_000, 5_000)).toBe(0);
  });
});

describe("SleepLedger — 会话累计", () => {
  test("初始状态为空", () => {
    const l = getSleepLedger();
    expect(l.hasSlept()).toBe(false);
    expect(l.getTotalMs()).toBe(0);
    expect(l.getEventCount()).toBe(0);
    expect(l.getLastAtMs()).toBeNull();
  });

  test("record 累计达阈值的跳跃并返回计入值", () => {
    const l = getSleepLedger();
    expect(l.record(926_241, 5_000)).toBe(921_241);
    expect(l.getTotalMs()).toBe(921_241);
    expect(l.getEventCount()).toBe(1);
    expect(l.hasSlept()).toBe(true);
    expect(l.getLastAtMs()).not.toBeNull();
  });

  test("未达阈值不计入、不增计数", () => {
    const l = getSleepLedger();
    expect(l.record(6_000, 5_000)).toBe(0);
    expect(l.getTotalMs()).toBe(0);
    expect(l.getEventCount()).toBe(0);
    expect(l.hasSlept()).toBe(false);
  });

  test("多次休眠累加（对应事故里的三段休眠）", () => {
    const l = getSleepLedger();
    l.record(938_877, 5_000);
    l.record(939_625, 5_000);
    l.record(946_386, 5_000);
    expect(l.getEventCount()).toBe(3);
    // 三段合计约 47 分钟——正是那次把 60 分钟会话额度睡掉大半的量
    expect(l.getTotalMs()).toBeGreaterThan(45 * 60_000);
  });

  test("两个定时器观测同一段休眠：恢复正常的那次 tick 不再计入（天然去重）", () => {
    const l = getSleepLedger();
    // 先醒来的定时器记下这段休眠
    expect(l.record(926_241, 5_000)).toBeGreaterThan(0);
    // 另一个定时器随后 tick 时间隔已恢复正常 → 不再重复计入
    expect(l.record(5_100, 5_000)).toBe(0);
    expect(l.getEventCount()).toBe(1);
  });
});

describe("describeSleep — 用户可见文案", () => {
  test("无休眠时返回 null（不给用户无谓噪音）", () => {
    expect(describeSleep()).toBeNull();
  });

  test("有休眠时说明时长与次数", () => {
    getSleepLedger().record(926_241, 5_000);
    const text = describeSleep();
    expect(text).not.toBeNull();
    expect(text).toContain("系统休眠");
    expect(text).toContain("15 分钟");
    expect(text).toContain("1 次");
  });

  test("不足 1 分钟用秒表述", () => {
    // 取值需同时满足两个约束：actual 必须过 FLOOR(30s) 才算休眠，而 gap
    // (=actual-expected) 又要 < 30s 才会走秒表述。expected=3s / actual=31s
    // 是这个窄窗口里的合法组合（gap=28s）。
    expect(getSleepLedger().record(31_000, 3_000)).toBe(28_000);
    expect(describeSleep()).toContain("秒");
  });
});
