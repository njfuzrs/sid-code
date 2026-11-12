/**
 * 请求输出预算（F8）——「本次请求打算预留多少输出」的解析。
 *
 * 这里只测预算基准（用户显式值 > 默认常量）。发送请求侧的完整钳制
 * （物理上限 / 窗口剩余 / floor 拒绝）由 F1 在同一文件扩展后再补。
 */

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_REQUEST_MAX_TOKENS,
  resolveRequestBudget,
} from "@sid-code/core/llm/output-budget.ts";

describe("resolveRequestBudget", () => {
  test("未显式配置时取默认 32,768（与 defaultConfig 兜底同源）", () => {
    expect(DEFAULT_REQUEST_MAX_TOKENS).toBe(32_768);
    expect(resolveRequestBudget()).toBe(32_768);
    expect(resolveRequestBudget(undefined)).toBe(32_768);
  });

  test("用户显式值优先", () => {
    expect(resolveRequestBudget(65_536)).toBe(65_536);
    // 小数向下取整，避免把非法精度的 max_tokens 发出去。
    expect(resolveRequestBudget(12_345.9)).toBe(12_345);
  });

  test("非法值（≤0 / NaN / Infinity）回退默认，绝不返回 0 或负数", () => {
    expect(resolveRequestBudget(0)).toBe(32_768);
    expect(resolveRequestBudget(-1)).toBe(32_768);
    expect(resolveRequestBudget(Number.NaN)).toBe(32_768);
    expect(resolveRequestBudget(Number.POSITIVE_INFINITY)).toBe(32_768);
  });
});
