import { describe, expect, test } from "bun:test";
import {
  quantize,
  computeQuantizedRange,
  findFirstVisible,
  findLastVisible,
  slideRange,
  OVERSCAN_ROWS,
  SCROLL_QUANTUM,
  SLIDE_STEP,
} from "../../src/ui/utils/scroll-quantum.ts";

describe("常量自洽", () => {
  test("SCROLL_QUANTUM 为 OVERSCAN 一半,保证量化误差落在 overscan 内", () => {
    expect(SCROLL_QUANTUM).toBe(OVERSCAN_ROWS >> 1);
    expect(SCROLL_QUANTUM).toBeLessThanOrEqual(OVERSCAN_ROWS);
  });
});

describe("quantize", () => {
  test("向下对齐到 quantum 边界", () => {
    expect(quantize(0, 40)).toBe(0);
    expect(quantize(39, 40)).toBe(0);
    expect(quantize(40, 40)).toBe(40);
    expect(quantize(79, 40)).toBe(40);
    expect(quantize(80, 40)).toBe(80);
  });

  test("同一 bin 内不同 scrollTop 量化到同值(commit 去抖核心)", () => {
    // 130 和 155 都落在 bin [120,160)
    const a = quantize(130, 40);
    const b = quantize(155, 40);
    expect(a).toBe(b);
    expect(a).toBe(120);
  });

  test("负值 clamp 到 0", () => {
    expect(quantize(-10, 40)).toBe(0);
  });

  test("quantum<=0 时原样返回", () => {
    expect(quantize(123, 0)).toBe(123);
  });

  test("默认使用 SCROLL_QUANTUM", () => {
    expect(quantize(45)).toBe(SCROLL_QUANTUM);
  });
});

describe("findFirstVisible / findLastVisible", () => {
  // 10 项,每项高 10:offsets = [0,10,20,...,100]
  const offsets = Array.from({ length: 11 }, (_, i) => i * 10);

  test("findFirstVisible 找视口顶部所在项", () => {
    expect(findFirstVisible(offsets, 0)).toBe(0);
    expect(findFirstVisible(offsets, 5)).toBe(0);
    expect(findFirstVisible(offsets, 10)).toBe(1);
    expect(findFirstVisible(offsets, 25)).toBe(2);
    expect(findFirstVisible(offsets, 95)).toBe(9);
  });

  test("findLastVisible 找视口底部所在项", () => {
    expect(findLastVisible(offsets, 5, 10)).toBe(0);
    expect(findLastVisible(offsets, 15, 10)).toBe(1);
    expect(findLastVisible(offsets, 1000, 10)).toBe(9);
  });

  test("二分与线性扫描结果一致(随机校验)", () => {
    const n = 200;
    const off = [0];
    for (let i = 0; i < n; i++) off.push(off[i] + (1 + (i % 7)));
    for (const top of [0, 1, 50, 123, off[n] - 1, off[n] + 100]) {
      // 线性参照实现
      let linear = 0;
      for (let i = 0; i < n; i++) {
        if (off[i + 1] > top) {
          linear = i;
          break;
        }
        linear = i;
      }
      expect(findFirstVisible(off, top)).toBe(linear);
    }
  });
});

describe("computeQuantizedRange", () => {
  // 1000 项,每项高 1:offsets[i] = i —— 足够大,使可见范围成为真实滑动窗口
  const offsets = Array.from({ length: 1001 }, (_, i) => i);
  const TOTAL = 1000;

  test("范围含 overscan 且 clamp 在 [0, totalItems-1]", () => {
    const r = computeQuantizedRange(400, 10, offsets, TOTAL, OVERSCAN_ROWS, SCROLL_QUANTUM);
    // scrollTop 400 → q=400,top=320,bottom=490
    expect(r.start).toBeGreaterThan(0);
    expect(r.start).toBeLessThanOrEqual(400);
    expect(r.end).toBeGreaterThanOrEqual(410); // 覆盖视口底部
    expect(r.end).toBeLessThanOrEqual(TOTAL - 1);
  });

  test("同一 quantum bin 内 scrollTop 变化,range 不变", () => {
    const r1 = computeQuantizedRange(402, 10, offsets, TOTAL);
    const r2 = computeQuantizedRange(415, 10, offsets, TOTAL);
    // 402 和 415 都量化到 400
    expect(r1).toEqual(r2);
  });

  test("跨越 bin 边界 range 变化", () => {
    const r1 = computeQuantizedRange(399, 10, offsets, TOTAL); // q=360
    const r2 = computeQuantizedRange(400, 10, offsets, TOTAL); // q=400
    expect(r1).not.toEqual(r2);
  });

  test("空列表返回 {0,0}", () => {
    expect(computeQuantizedRange(0, 10, [0], 0)).toEqual({ start: 0, end: 0 });
  });

  test("视口顶部项始终在范围内(正确性不变量)", () => {
    for (const st of [0, 133, 360, 588, 999]) {
      const r = computeQuantizedRange(st, 10, offsets, TOTAL, OVERSCAN_ROWS, SCROLL_QUANTUM);
      const topItem = findFirstVisible(offsets, st);
      expect(r.start).toBeLessThanOrEqual(topItem);
      expect(r.end).toBeGreaterThanOrEqual(topItem);
    }
  });
});

describe("slideRange", () => {
  test("限制单次扩展不超过 step", () => {
    const prev = { start: 50, end: 60 };
    const target = { start: 0, end: 200 };
    const r = slideRange(prev, target, SLIDE_STEP);
    expect(r.start).toBe(50 - SLIDE_STEP);
    expect(r.end).toBe(60 + SLIDE_STEP);
  });

  test("目标范围更小时直接收敛到目标(不超出 target)", () => {
    const prev = { start: 0, end: 100 };
    const target = { start: 40, end: 60 };
    const r = slideRange(prev, target, SLIDE_STEP);
    expect(r.start).toBe(40);
    expect(r.end).toBe(60);
  });

  test("多次 slide 最终收敛到 target", () => {
    const target = { start: 0, end: 300 };
    let cur = { start: 150, end: 150 };
    for (let i = 0; i < 20; i++) cur = slideRange(cur, target, SLIDE_STEP);
    expect(cur).toEqual(target);
  });
});
