/**
 * Token 精确估算测试
 */

import { describe, test, expect } from "bun:test";
import { estimateTextTokens } from "../../src/context/token.ts";

describe("estimateTextTokens", () => {
  test("空字符串返回 0", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  test("纯 ASCII 文本：约 0.20 token/char", () => {
    const text = "hello world"; // 11 chars
    const tokens = estimateTextTokens(text);
    // 11 * 0.20 = 2.2 → ceil = 3
    expect(tokens).toBe(3);
  });

  test("纯中文文本：约 0.55 token/char", () => {
    const text = "你好世界"; // 4 chars
    const tokens = estimateTextTokens(text);
    // 4 * 0.55 = 2.2 → ceil = 3（校准后中文系数 0.55，旧 1.3 高估 ~2.5 倍）
    expect(tokens).toBe(3);
  });

  test("中英文混合文本", () => {
    const text = "hello你好"; // 5 ASCII + 2 CJK
    const tokens = estimateTextTokens(text);
    // 5 * 0.20 + 2 * 0.55 = 1.0 + 1.1 = 2.1 → ceil = 3
    expect(tokens).toBe(3);
  });

  test("中文估算高于旧的 length/4 方式", () => {
    const chineseText = "这是一段中文测试文本用于验证精确估算";
    const oldEstimate = Math.ceil(chineseText.length / 4);
    const newEstimate = estimateTextTokens(chineseText);
    // 中文场景下新估算（0.55/字）仍高于旧的 length/4（0.25/字）
    expect(newEstimate).toBeGreaterThan(oldEstimate);
  });

  test("纯 ASCII 估算与旧方式接近", () => {
    const asciiText = "This is a test string for token estimation";
    const oldEstimate = Math.ceil(asciiText.length / 4);
    const newEstimate = estimateTextTokens(asciiText);
    // 纯 ASCII：新系数 0.20 与旧 length/4（0.25）接近，差距放宽到 ≤3
    expect(Math.abs(newEstimate - oldEstimate)).toBeLessThanOrEqual(3);
  });

  test("超长文本使用快速近似（按抽样语言占比加权）", () => {
    const longText = "a".repeat(200_000);
    const tokens = estimateTextTokens(longText);
    // EST-6：全 ASCII → 抽样占比 0 非 ASCII → 0.20/char。200000 * 0.20 = 40000
    expect(tokens).toBe(40_000);
  });

  test("超长纯中文文本按非 ASCII 系数估算", () => {
    const longChinese = "中".repeat(200_000);
    const tokens = estimateTextTokens(longChinese);
    // EST-6：全中文 → 0.55/char。200000 * 0.55 = 110000，ceil 后 110000（旧固定 0.35 会低估到 70000）
    expect(tokens).toBeGreaterThanOrEqual(110_000);
    expect(tokens).toBeLessThanOrEqual(110_001);
  });

  test("刚好在阈值边界的文本使用精确计算", () => {
    const text = "a".repeat(100_000);
    const tokens = estimateTextTokens(text);
    // 100000 * 0.20 ≈ 20000，浮点累加微漂移后 ceil → 20001
    expect(tokens).toBe(20_001);
  });

  test("超过阈值的文本使用快速近似", () => {
    const text = "a".repeat(100_001);
    const tokens = estimateTextTokens(text);
    // EST-6：全 ASCII → 0.20/char。100001 * 0.20 = 20000.2 → ceil = 20001
    expect(tokens).toBe(20_001);
  });
});
