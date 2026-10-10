/**
 * 缺陷 7：stream-json 模式 stdin 空闲上限的 env 解析。
 * 缺省关闭；非法值按关闭处理（不让手误把会话秒杀）。
 */
import { describe, test, expect } from "bun:test";
import { readSdkIdleTimeoutMs } from "../../src/app.ts";

describe("readSdkIdleTimeoutMs", () => {
  test("未设置 / 空串 → 0（关闭）", () => {
    expect(readSdkIdleTimeoutMs({})).toBe(0);
    expect(readSdkIdleTimeoutMs({ SID_CODE_SDK_IDLE_TIMEOUT_MS: "  " })).toBe(0);
  });

  test("正整数原样生效，小数向下取整", () => {
    expect(readSdkIdleTimeoutMs({ SID_CODE_SDK_IDLE_TIMEOUT_MS: "300000" })).toBe(300000);
    expect(readSdkIdleTimeoutMs({ SID_CODE_SDK_IDLE_TIMEOUT_MS: "1500.9" })).toBe(1500);
  });

  test("0 / 负数 / 非数字 → 0", () => {
    for (const v of ["0", "-1", "abc", "NaN", "Infinity"]) {
      expect(readSdkIdleTimeoutMs({ SID_CODE_SDK_IDLE_TIMEOUT_MS: v })).toBe(0);
    }
  });
});
