/**
 * 双击判定器单测（A1：空闲时双击 Esc 打不开回退面板）
 *
 * 判定逻辑是这次修复的核心，必须能用**注入时钟**精确测边界（799ms 算、801ms 不算），
 * 而不是靠真实计时（那类测试要么慢、要么 flaky）。所以它被写成纯函数而不是塞进 hook 内部。
 */

import { describe, test, expect } from "bun:test";
import {
  createDoublePressDetector,
  DOUBLE_ESC_WINDOW_MS,
} from "../../src/ui/hooks/double-press.ts";

/** 可控时钟：让测试精确推进毫秒，不依赖真实时间。 */
function makeClock() {
  let at = 0;
  return {
    now: () => at,
    set: (ms: number) => {
      at = ms;
    },
  };
}

describe("createDoublePressDetector", () => {
  test("窗口边界：0ms 与 799ms 两次 ⇒ 第二次命中", () => {
    const clock = makeClock();
    const d = createDoublePressDetector(DOUBLE_ESC_WINDOW_MS, clock.now);

    clock.set(0);
    expect(d.press()).toBe(false);
    clock.set(799);
    expect(d.press()).toBe(true);
  });

  test("窗口边界：0ms 与 801ms ⇒ 不命中，且 801 成为新的起点", () => {
    const clock = makeClock();
    const d = createDoublePressDetector(DOUBLE_ESC_WINDOW_MS, clock.now);

    clock.set(0);
    expect(d.press()).toBe(false);
    clock.set(801);
    expect(d.press()).toBe(false);
    // 801 那次没命中，但它自己成了新的起点 ⇒ 1000ms 距它只有 199ms。
    clock.set(1000);
    expect(d.press()).toBe(true);
  });

  test("reset 后紧接着再按不命中（Esc · 其它按键 · Esc 不算双击）", () => {
    const clock = makeClock();
    const d = createDoublePressDetector(DOUBLE_ESC_WINDOW_MS, clock.now);

    clock.set(0);
    expect(d.press()).toBe(false);
    d.reset();
    clock.set(100);
    expect(d.press()).toBe(false);
  });

  test("命中后自动复位：连按三次只触发一次", () => {
    const clock = makeClock();
    const d = createDoublePressDetector(DOUBLE_ESC_WINDOW_MS, clock.now);

    clock.set(0);
    expect(d.press()).toBe(false);
    clock.set(100);
    expect(d.press()).toBe(true);
    // 第三次距上一次 200ms，但上一次已经复位 ⇒ 不构成新的双击。
    clock.set(200);
    expect(d.press()).toBe(false);
  });

  test("窗口值与 cc 一致（800ms）", () => {
    // 与 claude-code/src/hooks/useDoublePress.ts:6 的 DOUBLE_PRESS_TIMEOUT_MS 同值，
    // 两套 TUI 的双击手感应当一致。改这个数会让「Esc Esc」和其他双击行为手感分叉。
    expect(DOUBLE_ESC_WINDOW_MS).toBe(800);
  });
});
