/**
 * 上下文压力告知单测（query/context-pressure.ts，缺口 A）
 *
 * 覆盖：阈值边界（未达不注入）、温和/强提醒分级、文案要点。
 * 纯函数测法——只测注入逻辑（可测），不测"模型是否真感知"（不可测）。
 */

import { describe, test, expect } from "bun:test";
import {
  buildContextPressureReminder,
  CONTEXT_PRESSURE_THRESHOLDS,
} from "../../src/query/context-pressure.ts";

describe("buildContextPressureReminder — 阈值边界", () => {
  test("使用率低于 warn 阈值时返回 null（不刷屏）", () => {
    expect(buildContextPressureReminder(0, 100)).toBeNull();
    expect(buildContextPressureReminder(50, 50)).toBeNull();
    expect(
      buildContextPressureReminder(CONTEXT_PRESSURE_THRESHOLDS.warn - 1, 21),
    ).toBeNull();
  });

  test("恰好达到 warn 阈值时注入温和提醒", () => {
    const r = buildContextPressureReminder(CONTEXT_PRESSURE_THRESHOLDS.warn, 20);
    expect(r).not.toBeNull();
    expect(r).toContain("上下文使用率");
    expect(r).toContain("<system-reminder>");
  });

  test("恰好达到 urgent 阈值时注入强提醒", () => {
    const r = buildContextPressureReminder(CONTEXT_PRESSURE_THRESHOLDS.urgent, 10);
    expect(r).not.toBeNull();
    expect(r).toContain("很快");
  });
});

describe("buildContextPressureReminder — 文案分级", () => {
  test("温和提醒（warn ≤ 使用率 < urgent）措辞平和、安抚不催促", () => {
    const r = buildContextPressureReminder(85, 15)!;
    expect(r).toContain("无需停下或赶工");
    expect(r).toContain("建议");
  });

  test("强提醒（≥ urgent）安抚而非催收尾（对标 claude-code 哲学）", () => {
    const r = buildContextPressureReminder(95, 5)!;
    expect(r).toContain("很快");
    expect(r).toContain("无需停下或赶工");
    // 反向断言：绝不催模型停止/收尾/收敛输出（会导致弱模型草草 end_turn）
    expect(r).not.toContain("停止");
    expect(r).not.toContain("立即完成收尾");
  });

  test("含使用率与剩余百分比、含落盘要点", () => {
    const r = buildContextPressureReminder(88, 12)!;
    expect(r).toContain("88%");
    expect(r).toContain("12%");
    expect(r).toContain("todo_write");
    expect(r).toContain("落盘");
  });

  test("两档都明确告知会自动压缩、可无缝继续（消除恐慌）", () => {
    const warn = buildContextPressureReminder(85, 15)!;
    const urgent = buildContextPressureReminder(95, 5)!;
    expect(warn).toContain("无缝继续");
    expect(urgent).toContain("无缝继续");
  });

  test("剩余百分比为负时夹到 0（防越界文案）", () => {
    const r = buildContextPressureReminder(102, -2)!;
    expect(r).toContain("剩余约 0%");
  });

  test("含'请勿向用户提及/复述'约束（对齐既有 reminder 风格）", () => {
    const warn = buildContextPressureReminder(85, 15)!;
    const urgent = buildContextPressureReminder(95, 5)!;
    expect(warn).toContain("请勿向用户");
    expect(urgent).toContain("请勿向用户");
  });
});
