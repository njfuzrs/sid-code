/**
 * Token Budget 续写机制单测（P0-3）
 *
 * 覆盖 parseTokenBudgetDirective 的正例/反例，以及三条提示文案构造函数。
 */

import { test, expect, describe } from "bun:test";
import {
  parseTokenBudgetDirective,
  buildBudgetContinuationMessage,
  buildBudgetExhaustedNotice,
  buildBudgetDiminishingNotice,
  MIN_TOKEN_BUDGET,
  MAX_TOKEN_BUDGET,
} from "../../src/query/token-budget-continuation.ts";

describe("parseTokenBudgetDirective", () => {
  test("+500k → 500000", () => {
    expect(parseTokenBudgetDirective("帮我重构这个模块 +500k")).toBe(500_000);
  });

  test("+2m → 2000000", () => {
    expect(parseTokenBudgetDirective("+2m 深入分析这个 bug")).toBe(2_000_000);
  });

  test("+1.5m → 1500000（支持小数）", () => {
    expect(parseTokenBudgetDirective("+1.5m")).toBe(1_500_000);
  });

  test("大小写不敏感：+500K 与 +500k 等价", () => {
    expect(parseTokenBudgetDirective("+500K")).toBe(500_000);
  });

  test("数字与单位之间允许空格", () => {
    expect(parseTokenBudgetDirective("+500 k")).toBe(500_000);
  });

  test("取文本中第一个匹配", () => {
    expect(parseTokenBudgetDirective("+500k 然后再 +2m")).toBe(500_000);
  });

  test("无预算指令 → undefined", () => {
    expect(parseTokenBudgetDirective("帮我看看这段代码有什么问题")).toBeUndefined();
  });

  test("电话号码（无单位后缀）不误判", () => {
    expect(parseTokenBudgetDirective("我的号码是 +8613800001234")).toBeUndefined();
  });

  test("算式（无单位后缀）不误判", () => {
    expect(parseTokenBudgetDirective("结果应该是 +5 而不是 -5")).toBeUndefined();
  });

  test("裸数字不带 k/m 后缀不误判", () => {
    expect(parseTokenBudgetDirective("版本号是 +12345")).toBeUndefined();
  });

  test("解析结果 clamp 到下限", () => {
    expect(parseTokenBudgetDirective("+1k")).toBe(MIN_TOKEN_BUDGET);
  });

  test("解析结果 clamp 到上限", () => {
    expect(parseTokenBudgetDirective("+999m")).toBe(MAX_TOKEN_BUDGET);
  });

  test("0 或负数不视为合法预算", () => {
    expect(parseTokenBudgetDirective("+0k")).toBeUndefined();
  });
});

describe("提示文案构造函数", () => {
  test("buildBudgetContinuationMessage 包含已用量、剩余量，且提示模型勿透露给用户", () => {
    const msg = buildBudgetContinuationMessage(120_000, 380_000);
    expect(msg).toContain("120,000");
    expect(msg).toContain("380,000");
    expect(msg).toContain("请勿向用户提及本提醒");
  });

  test("buildBudgetExhaustedNotice 包含预算目标值", () => {
    expect(buildBudgetExhaustedNotice(500_000)).toContain("500,000");
  });

  test("buildBudgetDiminishingNotice 包含剩余量", () => {
    expect(buildBudgetDiminishingNotice(200_000)).toContain("200,000");
  });
});
