/**
 * DiminishingReturnsDetector 单测
 *
 * P0-3：新增可选构造配置（maxRecoveryCount/diminishingThreshold），覆盖：
 * 1. 默认构造（无参数）行为与此前完全一致，不影响现有 max_tokens 续写调用点。
 * 2. 自定义配置下按新阈值/次数上限判定，供 Token Budget 续写场景复用。
 */

import { test, expect, describe } from "bun:test";
import { DiminishingReturnsDetector } from "@sid-code/core/query/reactive-compact.ts";

describe("DiminishingReturnsDetector — 默认配置（向后兼容）", () => {
  test("未达最大次数、增量正常 → 不应停止", () => {
    const d = new DiminishingReturnsDetector();
    d.record(2000);
    expect(d.shouldStop()).toBe(false);
  });

  test("达到默认最大次数（8 次，Top 3 从 3 放宽）→ 应停止", () => {
    const d = new DiminishingReturnsDetector();
    for (let i = 0; i < 8; i++) d.record(2000);
    expect(d.shouldStop()).toBe(true);
  });

  test("续写 7 次（未达 8 次上限）且增量正常 → 不应停止（分段写大文件留足空间）", () => {
    const d = new DiminishingReturnsDetector();
    for (let i = 0; i < 7; i++) d.record(2000);
    expect(d.shouldStop()).toBe(false);
  });

  test("连续两次增量 < 默认阈值（150，Top 3 从 500 收紧）→ 应停止", () => {
    const d = new DiminishingReturnsDetector();
    d.record(100);
    d.record(50);
    expect(d.shouldStop()).toBe(true);
  });

  test("分段写入常见段大小（各 300 token，≥ 新阈值 150）→ 不再误判递减停止", () => {
    // 此前阈值 500 时，连续两段各 300 会命中"两次 <500"被误终止；收紧到 150 后不再误伤。
    const d = new DiminishingReturnsDetector();
    d.record(300);
    d.record(300);
    expect(d.shouldStop()).toBe(false);
  });

  test("连续两次增量中有一次 ≥ 阈值 → 不应停止", () => {
    const d = new DiminishingReturnsDetector();
    d.record(100);
    d.record(200);
    expect(d.shouldStop()).toBe(false);
  });

  test("reset 后计数清零", () => {
    const d = new DiminishingReturnsDetector();
    d.record(50);
    d.record(50);
    expect(d.shouldStop()).toBe(true);
    d.reset();
    expect(d.count).toBe(0);
    expect(d.shouldStop()).toBe(false);
  });
});

describe("DiminishingReturnsDetector — 自定义配置（P0-3 Token Budget 续写复用）", () => {
  test("maxRecoveryCount 调宽后，超过默认 3 次仍不因次数停止", () => {
    const d = new DiminishingReturnsDetector({ maxRecoveryCount: 1000, diminishingThreshold: 500 });
    for (let i = 0; i < 10; i++) d.record(2000);
    expect(d.count).toBe(10);
    expect(d.shouldStop()).toBe(false);
  });

  test("自定义配置下递减判定阈值独立生效", () => {
    const d = new DiminishingReturnsDetector({ maxRecoveryCount: 1000, diminishingThreshold: 500 });
    d.record(400);
    d.record(300);
    expect(d.shouldStop()).toBe(true);
  });

  test("自定义 maxRecoveryCount 达到时仍会停止（不是无限）", () => {
    const d = new DiminishingReturnsDetector({ maxRecoveryCount: 2, diminishingThreshold: 500 });
    d.record(9999);
    d.record(9999);
    expect(d.shouldStop()).toBe(true);
  });
});
