/**
 * 缺口 C1 catch-up「只补最近一次」语义单测
 * 覆盖 parser.computeMissedRuns / computeLatestMissedRun。
 */

import { describe, it, expect } from "bun:test";
import {
  computeMissedRuns,
  computeLatestMissedRun,
} from "../../src/cron/parser.ts";

describe("computeMissedRuns", () => {
  it("枚举区间内每分钟任务的所有错过时刻", () => {
    // 10:00:30 → 10:05:00，每分钟任务应错过 10:01 10:02 10:03 10:04 10:05
    const from = new Date(2026, 5, 1, 10, 0, 30).getTime();
    const until = new Date(2026, 5, 1, 10, 5, 0).getTime();
    const missed = computeMissedRuns("*/1 * * * *", from, until);
    expect(missed.length).toBe(5);
    expect(new Date(missed[0]).getMinutes()).toBe(1);
    expect(new Date(missed[missed.length - 1]).getMinutes()).toBe(5);
  });

  it("until <= from 返回空", () => {
    const t = new Date(2026, 5, 1, 10, 0, 0).getTime();
    expect(computeMissedRuns("*/1 * * * *", t, t)).toEqual([]);
    expect(computeMissedRuns("*/1 * * * *", t, t - 1000)).toEqual([]);
  });

  it("maxRuns 上限截断超长停机", () => {
    // 停机一整年，每分钟任务，maxRuns=10 只取前 10 个
    const from = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const until = new Date(2026, 11, 31, 0, 0, 0).getTime();
    const missed = computeMissedRuns("*/1 * * * *", from, until, 10);
    expect(missed.length).toBe(10);
  });

  it("日任务长停机枚举出多个错过日", () => {
    // 每天 09:00，从 6/1 08:00 睡到 6/4 10:00，应错过 6/1 6/2 6/3 6/4 共 4 次
    const from = new Date(2026, 5, 1, 8, 0, 0).getTime();
    const until = new Date(2026, 5, 4, 10, 0, 0).getTime();
    const missed = computeMissedRuns("0 9 * * *", from, until);
    expect(missed.length).toBe(4);
  });
});

describe("computeLatestMissedRun（只补最近一次）", () => {
  it("日任务睡 6 天醒来只返回最近一次（丢弃更早的）", () => {
    // 每天 09:00，lastFired=6/1 09:00，now=6/7 10:00
    // 错过 6/2..6/7 共 6 次，但只补最近一次 = 6/7 09:00
    const from = new Date(2026, 5, 1, 9, 0, 0).getTime();
    const now = new Date(2026, 5, 7, 10, 0, 0).getTime();
    const latest = computeLatestMissedRun("0 9 * * *", from, now);
    expect(latest).not.toBeNull();
    const d = new Date(latest!);
    expect(d.getDate()).toBe(7);
    expect(d.getHours()).toBe(9);
  });

  it("无错过返回 null", () => {
    // 每天 09:00，从 10:00 到同日 11:00 之间无 09:00 触发点
    const from = new Date(2026, 5, 1, 10, 0, 0).getTime();
    const now = new Date(2026, 5, 1, 11, 0, 0).getTime();
    expect(computeLatestMissedRun("0 9 * * *", from, now)).toBeNull();
  });

  it("恰好一次错过即返回那一次", () => {
    const from = new Date(2026, 5, 1, 8, 0, 0).getTime();
    const now = new Date(2026, 5, 1, 9, 30, 0).getTime();
    const latest = computeLatestMissedRun("0 9 * * *", from, now);
    expect(latest).not.toBeNull();
    expect(new Date(latest!).getHours()).toBe(9);
  });
});
