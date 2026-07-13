/**
 * 上下文压力告知单测（query/context-pressure.ts，缺口 A）
 *
 * 覆盖：阈值边界（未达不注入）、温和/强提醒分级、文案要点。
 * 纯函数测法——只测注入逻辑（可测），不测"模型是否真感知"（不可测）。
 */

import { describe, test, expect } from "bun:test";
import {
  buildContextPressureReminder,
  contextPressureLevel,
  CONTEXT_PRESSURE_REMINDER_INTERVAL,
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

describe("contextPressureLevel — 档位判定", () => {
  test("未达 warn 返回 undefined", () => {
    expect(contextPressureLevel(0)).toBeUndefined();
    expect(contextPressureLevel(CONTEXT_PRESSURE_THRESHOLDS.warn - 1)).toBeUndefined();
  });

  test("warn ≤ 使用率 < urgent 返回 warn", () => {
    expect(contextPressureLevel(CONTEXT_PRESSURE_THRESHOLDS.warn)).toBe("warn");
    expect(contextPressureLevel(CONTEXT_PRESSURE_THRESHOLDS.urgent - 1)).toBe("warn");
  });

  test("使用率 ≥ urgent 返回 urgent", () => {
    expect(contextPressureLevel(CONTEXT_PRESSURE_THRESHOLDS.urgent)).toBe("urgent");
    expect(contextPressureLevel(100)).toBe("urgent");
  });
});

/**
 * cadence 节流逻辑（loop.ts 缺口 A 注入段）的行为规约。
 *
 * loop.ts 里的注入决策是内联逻辑，这里用一个等价的纯函数复刻它的判定规则，
 * 锁定"升档强注入 + 同档每 N 轮重述 + 脱离阈值刷新基线"三条不变量，
 * 防止后续重构悄悄回退成"每轮无条件注入"（对话重播/截断幻觉根因）。
 */
describe("上下文压力 cadence 节流规约", () => {
  // 复刻 loop.ts 的判定：给定档位与轮次状态，是否应注入 + 更新后的状态。
  function decidePressureInjection(args: {
    level: "warn" | "urgent" | undefined;
    turnCount: number;
    lastSeenLevel: "warn" | "urgent" | undefined;
    lastReminderTurn: number | undefined;
    interval?: number;
  }): { inject: boolean; nextLastReminderTurn: number | undefined } {
    const interval = args.interval ?? CONTEXT_PRESSURE_REMINDER_INTERVAL;
    if (!args.level) {
      return { inject: false, nextLastReminderTurn: args.lastReminderTurn };
    }
    const changed = args.lastSeenLevel !== args.level;
    const turnsSince = args.turnCount - (args.lastReminderTurn ?? 0);
    if (changed || turnsSince >= interval) {
      return { inject: true, nextLastReminderTurn: args.turnCount };
    }
    return { inject: false, nextLastReminderTurn: args.lastReminderTurn };
  }

  test("未达阈值不注入", () => {
    const d = decidePressureInjection({
      level: undefined,
      turnCount: 5,
      lastSeenLevel: undefined,
      lastReminderTurn: undefined,
    });
    expect(d.inject).toBe(false);
  });

  test("首次达标（undefined→warn）强注入", () => {
    const d = decidePressureInjection({
      level: "warn",
      turnCount: 10,
      lastSeenLevel: undefined,
      lastReminderTurn: undefined,
    });
    expect(d.inject).toBe(true);
    expect(d.nextLastReminderTurn).toBe(10);
  });

  test("升档（warn→urgent）即使刚注入过也强注入", () => {
    const d = decidePressureInjection({
      level: "urgent",
      turnCount: 11,
      lastSeenLevel: "warn",
      lastReminderTurn: 10, // 上轮刚注入
    });
    expect(d.inject).toBe(true);
  });

  test("同档持续、未到重述间隔 → 不注入（节流的核心，防幻影用户消息）", () => {
    // 关键回归：长任务卡在 85% 连续多轮，同一条安抚提醒不再每轮注入
    for (let t = 11; t < 10 + CONTEXT_PRESSURE_REMINDER_INTERVAL; t++) {
      const d = decidePressureInjection({
        level: "warn",
        turnCount: t,
        lastSeenLevel: "warn",
        lastReminderTurn: 10,
      });
      expect(d.inject).toBe(false);
    }
  });

  test("同档持续、达到重述间隔 → 低频重述一次", () => {
    const d = decidePressureInjection({
      level: "warn",
      turnCount: 10 + CONTEXT_PRESSURE_REMINDER_INTERVAL,
      lastSeenLevel: "warn",
      lastReminderTurn: 10,
    });
    expect(d.inject).toBe(true);
    expect(d.nextLastReminderTurn).toBe(10 + CONTEXT_PRESSURE_REMINDER_INTERVAL);
  });

  test("脱离阈值后回升，重新识别为升档强注入", () => {
    // 卡在 warn → 压缩后回落到阈值下（level=undefined，基线刷新为 undefined）
    // → 再次爬升到 warn，应被视为 changed 再注入一次
    const afterDrop = decidePressureInjection({
      level: undefined,
      turnCount: 20,
      lastSeenLevel: "warn",
      lastReminderTurn: 10,
    });
    expect(afterDrop.inject).toBe(false);
    // loop.ts 里 lastSeenLevel 被刷新为 undefined；模拟再升档
    const reclimb = decidePressureInjection({
      level: "warn",
      turnCount: 25,
      lastSeenLevel: undefined, // 已被刷新
      lastReminderTurn: 10,
    });
    expect(reclimb.inject).toBe(true);
  });
});
