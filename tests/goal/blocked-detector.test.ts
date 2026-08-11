/**
 * BlockedDetector 单测
 *
 * 验证连续卡住检测逻辑：连续 N 轮相同 blockerKey 判定为 blocked，
 * 无 blockerKey 时重置计数，不同 key 不触发。
 */

import { describe, test, expect } from "bun:test";
import { BlockedDetector } from "@sid-code/core/goal/blocked-detector.ts";

describe("BlockedDetector", () => {
  test("连续相同 blockerKey 达到 threshold 时判定 blocked", () => {
    const detector = new BlockedDetector(3);
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("auth_login_fail")).toBe(true); // 第 3 次
  });

  test("不同 blockerKey 不触发", () => {
    const detector = new BlockedDetector(3);
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("db_connection")).toBe(false); // 换了 key
    expect(detector.record("db_connection")).toBe(false);
    expect(detector.record("db_connection")).toBe(true); // 连续 3 次
  });

  test("undefined blockerKey 重置计数", () => {
    const detector = new BlockedDetector(3);
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record(undefined)).toBe(false); // 重置
    expect(detector.record("auth_login_fail")).toBe(false); // 重新开始
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("auth_login_fail")).toBe(true); // 再次达到 3
  });

  test("reset() 清空历史", () => {
    const detector = new BlockedDetector(3);
    detector.record("auth_login_fail");
    detector.record("auth_login_fail");
    detector.reset();
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("auth_login_fail")).toBe(false);
    expect(detector.record("auth_login_fail")).toBe(true);
  });

  test("threshold=1 时首次就触发", () => {
    const detector = new BlockedDetector(1);
    expect(detector.record("stuck")).toBe(true);
  });

  test("默认 threshold=3", () => {
    const detector = new BlockedDetector();
    expect(detector.record("x")).toBe(false);
    expect(detector.record("x")).toBe(false);
    expect(detector.record("x")).toBe(true);
  });
});
