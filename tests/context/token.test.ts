/**
 * Token 精确估算测试
 */

import { describe, test, expect } from "bun:test";
import { estimateTextTokens } from "../../src/context/token.ts";

describe("estimateTextTokens", () => {
  test("空字符串返回 0", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  test("纯 ASCII 文本：约 0.25 token/char", () => {
    const text = "hello world"; // 11 chars
    const tokens = estimateTextTokens(text);
    // 11 * 0.25 = 2.75 → ceil = 3
    expect(tokens).toBe(3);
  });

  test("纯中文文本：约 1.3 token/char", () => {
    const text = "你好世界"; // 4 chars
    const tokens = estimateTextTokens(text);
    // 4 * 1.3 = 5.2 → ceil = 6
    expect(tokens).toBe(6);
  });

  test("中英文混合文本", () => {
    const text = "hello你好"; // 5 ASCII + 2 CJK
    const tokens = estimateTextTokens(text);
    // 5 * 0.25 + 2 * 1.3 = 1.25 + 2.6 = 3.85 → ceil = 4
    expect(tokens).toBe(4);
  });

  test("中文估算高于旧的 length/4 方式", () => {
    const chineseText = "这是一段中文测试文本用于验证精确估算";
    const oldEstimate = Math.ceil(chineseText.length / 4);
    const newEstimate = estimateTextTokens(chineseText);
    // 中文场景下新估算应显著高于旧估算
    expect(newEstimate).toBeGreaterThan(oldEstimate);
  });

  test("纯 ASCII 估算与旧方式接近", () => {
    const asciiText = "This is a test string for token estimation";
    const oldEstimate = Math.ceil(asciiText.length / 4);
    const newEstimate = estimateTextTokens(asciiText);
    // 纯 ASCII 两种方式应接近
    expect(Math.abs(newEstimate - oldEstimate)).toBeLessThanOrEqual(1);
  });

  test("超长文本使用快速近似", () => {
    const longText = "a".repeat(200_000);
    const tokens = estimateTextTokens(longText);
    // 200000 * 0.35 = 70000
    expect(tokens).toBe(70_000);
  });

  test("刚好在阈值边界的文本使用精确计算", () => {
    const text = "a".repeat(100_000);
    const tokens = estimateTextTokens(text);
    // 100000 * 0.25 = 25000
    expect(tokens).toBe(25_000);
  });

  test("超过阈值的文本使用快速近似", () => {
    const text = "a".repeat(100_001);
    const tokens = estimateTextTokens(text);
    // 100001 * 0.35 = 35000.35 → ceil = 35001
    expect(tokens).toBe(35_001);
  });
});
