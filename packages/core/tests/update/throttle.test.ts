/**
 * 自动更新 — 节流逻辑单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { shouldCheck } from "@sid-code/core/update/throttle.ts";
import type { UpdateState } from "@sid-code/core/update/state.ts";

describe("throttle", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.SID_CODE_UPDATE_CHECK_INTERVAL_HOURS;
    delete process.env.SID_CODE_UPDATE_CHECK_INTERVAL_HOURS;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SID_CODE_UPDATE_CHECK_INTERVAL_HOURS;
    else process.env.SID_CODE_UPDATE_CHECK_INTERVAL_HOURS = prevEnv;
  });

  test("从未检查过 → 应该检查", () => {
    const state: UpdateState = { consecutiveFailures: 0 };
    expect(shouldCheck(state)).toBe(true);
  });

  test("lastCheckAt 损坏 → 视为从未检查", () => {
    const state: UpdateState = {
      lastCheckAt: "invalid-date",
      consecutiveFailures: 0,
    };
    expect(shouldCheck(state)).toBe(true);
  });

  test("距上次检查 < 24h → 不检查", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const state: UpdateState = {
      lastCheckAt: "2026-09-14T00:00:00Z", // 12 小时前
      consecutiveFailures: 0,
    };
    expect(shouldCheck(state, now)).toBe(false);
  });

  test("距上次检查 >= 24h → 应该检查", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const state: UpdateState = {
      lastCheckAt: "2026-09-13T12:00:00Z", // 24 小时前
      consecutiveFailures: 0,
    };
    expect(shouldCheck(state, now)).toBe(true);
  });

  test("距上次检查 > 24h → 应该检查", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const state: UpdateState = {
      lastCheckAt: "2026-09-13T12:00:00Z", // 48 小时前
      consecutiveFailures: 0,
    };
    expect(shouldCheck(state, now)).toBe(true);
  });

  test("env 覆盖间隔（1 小时）", () => {
    process.env.SID_CODE_UPDATE_CHECK_INTERVAL_HOURS = "1";
    const now = new Date("2026-09-14T12:00:00Z");
    const state: UpdateState = {
      lastCheckAt: "2026-09-14T10:00:00Z", // 2 小时前
      consecutiveFailures: 0,
    };
    expect(shouldCheck(state, now)).toBe(true);
  });

  test("env 非法值 → 使用默认 24h", () => {
    process.env.SID_CODE_UPDATE_CHECK_INTERVAL_HOURS = "invalid";
    const now = new Date("2026-09-14T12:00:00Z");
    const state: UpdateState = {
      lastCheckAt: "2026-09-14T00:00:00Z", // 12 小时前
      consecutiveFailures: 0,
    };
    expect(shouldCheck(state, now)).toBe(false);
  });
});
