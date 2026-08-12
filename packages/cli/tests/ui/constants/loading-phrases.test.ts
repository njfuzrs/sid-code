/**
 * loading-phrases 慢提示阈值测试
 *
 * pickSlowHint 是纯函数：按【静默秒数】（距上次收到模型输出的秒数，非整轮累计耗时）
 * 取命中的最大阈值文案，未达首阈值返回 null。
 */

import { test, expect, describe } from "bun:test";
import {
  pickSlowHint,
  SLOW_RESPONSE_HINTS,
  CONNECTING_PHRASE,
  CONTINUATION_PHRASE,
  formatToolElapsed,
  TOOL_TIMER_THRESHOLD_SEC,
} from "@sid-code/cli/ui/constants/loading-phrases.ts";

describe("pickSlowHint", () => {
  // 阈值不写死在断言里——从 SLOW_RESPONSE_HINTS 取，调阈值时测试自动跟随。
  const [first, second] = SLOW_RESPONSE_HINTS;

  test("未达首阈值返回 null（静默时间短 = 模型在产出，不报慢）", () => {
    expect(pickSlowHint(0)).toBeNull();
    expect(pickSlowHint(5)).toBeNull();
    expect(pickSlowHint(first.thresholdSec - 1)).toBeNull();
  });

  test("命中首阈值 → 第一档文案（仅陈述还在等，不报警）", () => {
    expect(pickSlowHint(first.thresholdSec)).toBe(first.hint);
    expect(pickSlowHint(second.thresholdSec - 1)).toBe(first.hint);
  });

  test("命中次阈值 → 第二档文案（给出路 esc）", () => {
    expect(pickSlowHint(second.thresholdSec)).toBe(second.hint);
    expect(pickSlowHint(second.thresholdSec + 100)).toBe(second.hint);
  });

  test("阈值递增——取命中的最大阈值，不会越档错配", () => {
    // 介于两档之间应命中较低档；超过次档命中次档。
    expect(pickSlowHint(second.thresholdSec - 1)).toBe(first.hint);
    expect(pickSlowHint(second.thresholdSec + 1)).toBe(second.hint);
  });

  test("慢提示文案不武断断言网络/卡死（只陈述事实 + 给出口）", () => {
    // 回归保护：避免重新引入「网络较忙 / 模型卡住」这类推测性、会误导用户的措辞。
    for (const { hint } of SLOW_RESPONSE_HINTS) {
      expect(hint).not.toContain("网络");
      expect(hint).not.toContain("卡");
    }
  });

  test("CONNECTING_PHRASE 是固定的连接文案", () => {
    expect(CONNECTING_PHRASE).toBe("连接中…");
  });

  test("CONTINUATION_PHRASE 是步间空档文案（已产出 token 时用，非连接）", () => {
    expect(CONTINUATION_PHRASE).toBe("处理中…");
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
