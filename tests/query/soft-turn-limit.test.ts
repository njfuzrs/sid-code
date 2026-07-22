/**
 * 【第四层·兜底】SID_MAX_TURNS 软阈值提醒单测（query/soft-turn-limit.ts）
 *
 * 回归目标（根治「git 快照冻结死循环」§5 第四层）：
 *   交互模式 maxTurns=Infinity 场景下补一个**可选、软性**的自省信号。默认关闭
 *   （不设 SID_MAX_TURNS 则永不介入），显式开启后达阈值一次性提醒、不强杀。
 */

import { describe, test, expect } from "bun:test";
import {
  parseSoftTurnLimit,
  shouldRemindSoftTurnLimit,
  buildSoftTurnLimitReminder,
} from "../../src/query/soft-turn-limit.ts";

describe("parseSoftTurnLimit — 阈值解析", () => {
  test("未设置 / 空串 → undefined（不启用）", () => {
    expect(parseSoftTurnLimit(undefined)).toBeUndefined();
    expect(parseSoftTurnLimit("")).toBeUndefined();
    expect(parseSoftTurnLimit("   ")).toBeUndefined();
  });

  test("正整数 → 原值", () => {
    expect(parseSoftTurnLimit("50")).toBe(50);
    expect(parseSoftTurnLimit(" 30 ")).toBe(30);
    expect(parseSoftTurnLimit("1")).toBe(1);
  });

  test("非法值（<=0 / 非数字 / 小数）→ undefined", () => {
    expect(parseSoftTurnLimit("0")).toBeUndefined();
    expect(parseSoftTurnLimit("-5")).toBeUndefined();
    expect(parseSoftTurnLimit("abc")).toBeUndefined();
    expect(parseSoftTurnLimit("12.5")).toBeUndefined();
    expect(parseSoftTurnLimit("NaN")).toBeUndefined();
  });
});

describe("shouldRemindSoftTurnLimit — 一次性判定", () => {
  test("未启用（softLimit=undefined）→ 永不提醒", () => {
    expect(shouldRemindSoftTurnLimit(100, undefined, false)).toBe(false);
  });

  test("已提醒过 → 不再提醒（一次性）", () => {
    expect(shouldRemindSoftTurnLimit(100, 50, true)).toBe(false);
  });

  test("未达阈值 → 不提醒", () => {
    expect(shouldRemindSoftTurnLimit(49, 50, false)).toBe(false);
  });

  test("恰好达阈值且未提醒过 → 提醒", () => {
    expect(shouldRemindSoftTurnLimit(50, 50, false)).toBe(true);
    expect(shouldRemindSoftTurnLimit(60, 50, false)).toBe(true);
  });
});

describe("buildSoftTurnLimitReminder — 文案（软性、不强杀）", () => {
  test("含轮次、阈值、system-reminder 包裹，且措辞为软提示", () => {
    const msg = buildSoftTurnLimitReminder(55, 50);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("</system-reminder>");
    expect(msg).toContain("55");
    expect(msg).toContain("50");
    // 关键：软提示语气——明确"不强制中断"，不下达"必须停止"的硬指令。
    expect(msg).toContain("不强制中断");
    expect(msg).toContain("如果任务实际上已经完成");
  });
});
