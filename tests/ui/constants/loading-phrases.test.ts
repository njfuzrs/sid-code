/**
 * loading-phrases 慢提示阈值测试（§6.3）
 *
 * pickSlowHint 是纯函数：按已等待秒数取命中的最大阈值文案，未达首阈值返回 null。
 */

import { test, expect, describe } from "bun:test";
import {
  pickSlowHint,
  SLOW_RESPONSE_HINTS,
  CONNECTING_PHRASE,
  formatToolElapsed,
  TOOL_TIMER_THRESHOLD_SEC,
} from "../../../src/ui/constants/loading-phrases.ts";

describe("pickSlowHint", () => {
  test("未达首阈值（<10s）返回 null", () => {
    expect(pickSlowHint(0)).toBeNull();
    expect(pickSlowHint(5)).toBeNull();
    expect(pickSlowHint(9)).toBeNull();
  });

  test("命中 10s 阈值 → 第一档文案", () => {
    expect(pickSlowHint(10)).toBe(SLOW_RESPONSE_HINTS[0].hint);
    expect(pickSlowHint(29)).toBe(SLOW_RESPONSE_HINTS[0].hint);
  });

  test("命中 30s 阈值 → 第二档文案（给出路）", () => {
    expect(pickSlowHint(30)).toBe(SLOW_RESPONSE_HINTS[1].hint);
    expect(pickSlowHint(59)).toBe(SLOW_RESPONSE_HINTS[1].hint);
  });

  test("命中 60s 阈值 → 第三档文案（建议排查）", () => {
    expect(pickSlowHint(60)).toBe(SLOW_RESPONSE_HINTS[2].hint);
    expect(pickSlowHint(120)).toBe(SLOW_RESPONSE_HINTS[2].hint);
  });

  test("阈值递增——取命中的最大阈值，不会越档错配", () => {
    // 35s 应命中 30s 档而非 10s 档
    expect(pickSlowHint(35)).toBe(SLOW_RESPONSE_HINTS[1].hint);
  });

  test("CONNECTING_PHRASE 是固定的连接文案", () => {
    expect(CONNECTING_PHRASE).toBe("连接中…");
  });
});

describe("formatToolElapsed", () => {
  test("不足 60s 用秒", () => {
    expect(formatToolElapsed(8)).toBe("已执行 8s");
    expect(formatToolElapsed(59)).toBe("已执行 59s");
  });

  test("超过 60s 用分秒", () => {
    expect(formatToolElapsed(60)).toBe("已执行 1m0s");
    expect(formatToolElapsed(75)).toBe("已执行 1m15s");
    expect(formatToolElapsed(125)).toBe("已执行 2m5s");
  });

  test("工具计时阈值为 5s", () => {
    expect(TOOL_TIMER_THRESHOLD_SEC).toBe(5);
  });
});
