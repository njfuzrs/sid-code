/**
 * LY2 — 屏幕阅读器探测测试
 */

import { test, expect, describe } from "bun:test";
import { detectScreenReader } from "../../src/ui/accessibility/detect.ts";

describe("LY2 — detectScreenReader", () => {
  test("显式 SID_ACCESSIBILITY=1 开启", () => {
    expect(detectScreenReader({ SID_ACCESSIBILITY: "1" })).toBe(true);
    expect(detectScreenReader({ SID_ACCESSIBILITY: "true" })).toBe(true);
    expect(detectScreenReader({ SID_ACCESSIBILITY: "on" })).toBe(true);
  });

  test("显式 SID_ACCESSIBILITY=0 关闭（即使其它信号命中）", () => {
    expect(
      detectScreenReader({ SID_ACCESSIBILITY: "0", SCREEN_READER: "1" }),
    ).toBe(false);
  });

  test("SID_SCREEN_READER 同样生效", () => {
    expect(detectScreenReader({ SID_SCREEN_READER: "yes" })).toBe(true);
    expect(detectScreenReader({ SID_SCREEN_READER: "no" })).toBe(false);
  });

  test("辅助技术环境信号命中", () => {
    expect(detectScreenReader({ ACCESSIBILITY_ENABLED: "1" })).toBe(true);
    expect(detectScreenReader({ SCREEN_READER: "1" })).toBe(true);
  });

  test("默认关闭", () => {
    expect(detectScreenReader({})).toBe(false);
    expect(detectScreenReader({ PATH: "/usr/bin" })).toBe(false);
  });
});
