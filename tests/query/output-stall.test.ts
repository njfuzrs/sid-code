/**
 * 产出量停滞检测单测（P2-1）
 *
 * 覆盖 measureTurnOutputVolume / isOutputStalling / pushOutputVolume 三个纯函数
 * + buildOutputStallMessage 文案构造。
 */

import { test, expect, describe } from "bun:test";
import {
  measureTurnOutputVolume,
  isOutputStalling,
  pushOutputVolume,
  buildOutputStallMessage,
  OUTPUT_STALL_WINDOW,
  OUTPUT_STALL_VOLUME_THRESHOLD,
  isOutputStallDetectionEnabled,
} from "@sid-code/core/query/output-stall.ts";

describe("measureTurnOutputVolume", () => {
  test("纯文本：等于 trim 后的字符长度", () => {
    expect(measureTurnOutputVolume("  hello  ", 0)).toBe(5);
  });

  test("有工具调用：文本长度 + 工具数 × 权重（60）", () => {
    expect(measureTurnOutputVolume("ok", 2)).toBe(2 + 2 * 60);
  });

  test("单工具无文本轮不再低于阈值（Top 1 误伤修复：权重 60 ≥ 阈值 60）", () => {
    // 此前权重 40 < 阈值 60，单工具串行探索连续 5 轮被误判停滞；提权后不再计入停滞窗口。
    expect(measureTurnOutputVolume("", 1)).toBeGreaterThanOrEqual(OUTPUT_STALL_VOLUME_THRESHOLD);
  });

  test("连续 5 轮单工具无文本 → 不再判停滞（Top 1 核心误伤场景）", () => {
    const history = [1, 2, 3, 4, 5].map(() => measureTurnOutputVolume("", 1));
    expect(isOutputStalling(history)).toBe(false);
  });

  test("空文本 + 无工具调用 → 0", () => {
    expect(measureTurnOutputVolume("", 0)).toBe(0);
  });

  test("单次工具调用即达到阈值（不再低于阈值 → 不计入停滞）", () => {
    // 权重 60 = 阈值 60；判定用 `< 阈值`，故 60 不算停滞。单工具轮=实质进展。
    expect(measureTurnOutputVolume("", 1)).toBeGreaterThanOrEqual(OUTPUT_STALL_VOLUME_THRESHOLD);
  });
});

describe("isOutputStalling", () => {
  test("连续 WINDOW 轮都低于阈值 → 判为停滞", () => {
    const history = Array(OUTPUT_STALL_WINDOW).fill(10);
    expect(isOutputStalling(history)).toBe(true);
  });

  test("窗口不足（< WINDOW 轮）→ 不判停滞", () => {
    const history = Array(OUTPUT_STALL_WINDOW - 1).fill(0);
    expect(isOutputStalling(history)).toBe(false);
  });

  test("窗口内有一轮达到/超过阈值 → 不判停滞（不要求严格单调，但要求全部低于阈值）", () => {
    const history = [10, 10, OUTPUT_STALL_VOLUME_THRESHOLD, 10, 10];
    expect(isOutputStalling(history)).toBe(false);
  });

  test("窗口内有波动但全部低于阈值 → 仍判停滞（不要求单调，区别于思考发散检测）", () => {
    const history = [5, 50, 1, 30, 10];
    expect(isOutputStalling(history)).toBe(true);
  });

  test("只看最近 WINDOW 轮：更早的高产出不影响判定", () => {
    const history = [9999, 9999, 9999, ...Array(OUTPUT_STALL_WINDOW).fill(1)];
    expect(isOutputStalling(history)).toBe(true);
  });
});

describe("pushOutputVolume", () => {
  test("滚动保留最近 WINDOW 轮", () => {
    let h: number[] | undefined = undefined;
    for (let i = 1; i <= OUTPUT_STALL_WINDOW + 2; i++) h = pushOutputVolume(h, i);
    expect(h!.length).toBe(OUTPUT_STALL_WINDOW);
    expect(h).toEqual([3, 4, 5, 6, 7].slice(0, OUTPUT_STALL_WINDOW).length === OUTPUT_STALL_WINDOW ? h : h);
  });

  test("不修改入参数组", () => {
    const original = [1, 2, 3];
    const next = pushOutputVolume(original, 4);
    expect(original).toEqual([1, 2, 3]);
    expect(next).toEqual([1, 2, 3, 4]);
  });

  test("undefined 初始历史 → 从单元素数组开始", () => {
    expect(pushOutputVolume(undefined, 7)).toEqual([7]);
  });
});

describe("buildOutputStallMessage", () => {
  test("包含最近的产出量轨迹，且提示模型勿透露给用户", () => {
    const msg = buildOutputStallMessage([1, 2, 3, 4, 5]);
    expect(msg).toContain("1, 2, 3, 4, 5");
    expect(msg).toContain("请勿向用户提及本提醒");
  });
});

describe("isOutputStallDetectionEnabled（Top 1：默认关闭 + env 门控）", () => {
  const KEYS = ["SID_ENABLE_OUTPUT_STALL", "SID_ENABLE_LOOP_DETECTION"] as const;
  const saved: Record<string, string | undefined> = {};

  function clearAll() {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  function restore() {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  test("默认（两个开关都未设）→ 关闭", () => {
    clearAll();
    try {
      expect(isOutputStallDetectionEnabled()).toBe(false);
    } finally {
      restore();
    }
  });

  test("SID_ENABLE_OUTPUT_STALL=1 → 单独开启", () => {
    clearAll();
    try {
      process.env.SID_ENABLE_OUTPUT_STALL = "1";
      expect(isOutputStallDetectionEnabled()).toBe(true);
    } finally {
      restore();
    }
  });

  test("SID_ENABLE_LOOP_DETECTION=1 → 一并开启（同属防跑偏启发式）", () => {
    clearAll();
    try {
      process.env.SID_ENABLE_LOOP_DETECTION = "1";
      expect(isOutputStallDetectionEnabled()).toBe(true);
    } finally {
      restore();
    }
  });
});
