/**
 * isRecommendedLabel 纯函数单测
 *
 * AskUserQuestion 选项 label 若带「推荐」后缀，UI 给该项加品牌蓝强调。
 * 识别规则：结尾处的 (推荐) / （推荐） / (Recommended)（大小写不敏感，容忍首尾空白、全半角括号）。
 */

import { test, expect, describe } from "bun:test";
import { isRecommendedLabel } from "./DialogManager.tsx";

describe("isRecommendedLabel — 推荐后缀识别", () => {
  test("半角括号 (推荐)", () => {
    expect(isRecommendedLabel("方案A (推荐)")).toBe(true);
  });

  test("全角括号（推荐）", () => {
    expect(isRecommendedLabel("用 JWT（推荐）")).toBe(true);
  });

  test("英文 (Recommended) 大小写不敏感", () => {
    expect(isRecommendedLabel("Option B (Recommended)")).toBe(true);
    expect(isRecommendedLabel("(RECOMMENDED)")).toBe(true);
    expect(isRecommendedLabel("x (recommended)")).toBe(true);
  });

  test("尾部有空白仍识别", () => {
    expect(isRecommendedLabel("方案A (推荐)   ")).toBe(true);
  });

  test("无后缀 → false", () => {
    expect(isRecommendedLabel("选项C")).toBe(false);
    expect(isRecommendedLabel("recommended")).toBe(false); // 无括号不算
    expect(isRecommendedLabel("推荐使用这个")).toBe(false); // 不在结尾括号里
  });

  test("推荐后缀不在结尾（后面还有字）→ false", () => {
    expect(isRecommendedLabel("(推荐) 但有风险")).toBe(false);
  });
});
