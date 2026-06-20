/**
 * 状态栏 effort/thinking 派生单测（useStatusLineData 的纯函数部分）。
 * 纯函数不依赖 React，可直接单测。
 */

import { describe, expect, test } from "bun:test";
import { deriveEffort, deriveThinking } from "../../src/ui/hooks/useStatusLineData.ts";
import {
  EFFORT_LOW,
  EFFORT_MEDIUM,
  EFFORT_HIGH,
  EFFORT_MAX,
  EFFORT_AUTO,
  THINKING_ON,
  THINKING_OFF,
} from "../../src/ui/constants/figures.ts";

const GRAY = "#888";

describe("deriveEffort", () => {
  test("null → 不渲染该列", () => {
    expect(deriveEffort(null, GRAY)).toBeNull();
  });

  test("显式档位 → 对应填充字形 + 档位名", () => {
    expect(deriveEffort({ level: "low", isAuto: false }, GRAY)).toMatchObject({
      glyph: EFFORT_LOW,
      text: "low",
    });
    expect(deriveEffort({ level: "medium", isAuto: false }, GRAY)?.glyph).toBe(EFFORT_MEDIUM);
    expect(deriveEffort({ level: "high", isAuto: false }, GRAY)?.glyph).toBe(EFFORT_HIGH);
    expect(deriveEffort({ level: "max", isAuto: false }, GRAY)?.glyph).toBe(EFFORT_MAX);
  });

  test("max 档用品牌色点睛，其余用默认灰", () => {
    const max = deriveEffort({ level: "max", isAuto: false }, GRAY);
    const high = deriveEffort({ level: "high", isAuto: false }, GRAY);
    expect(max?.color).not.toBe(GRAY); // max 点睛色
    expect(high?.color).toBe(GRAY);
  });

  test("auto 态 → 空心点字形 + (auto) 后缀 + 灰色", () => {
    const r = deriveEffort({ level: "high", isAuto: true }, GRAY);
    expect(r?.glyph).toBe(EFFORT_AUTO);
    expect(r?.text).toBe("high (auto)");
    expect(r?.color).toBe(GRAY);
  });
});

describe("deriveThinking", () => {
  test("null → 不渲染该列", () => {
    expect(deriveThinking(null, GRAY)).toBeNull();
  });

  test("on（非 auto）→ 实心星 + 点睛色", () => {
    const r = deriveThinking({ on: true, isAuto: false }, GRAY);
    expect(r?.glyph).toBe(THINKING_ON);
    expect(r?.text).toBe("on");
    expect(r?.color).not.toBe(GRAY);
  });

  test("off → 空心星 + 灰色", () => {
    const r = deriveThinking({ on: false, isAuto: false }, GRAY);
    expect(r?.glyph).toBe(THINKING_OFF);
    expect(r?.text).toBe("off");
    expect(r?.color).toBe(GRAY);
  });

  test("auto 态 → (auto) 后缀，颜色保持灰（不点睛）", () => {
    const on = deriveThinking({ on: true, isAuto: true }, GRAY);
    expect(on?.text).toBe("on (auto)");
    expect(on?.color).toBe(GRAY); // auto 不点睛
    const off = deriveThinking({ on: false, isAuto: true }, GRAY);
    expect(off?.text).toBe("off (auto)");
  });
});
