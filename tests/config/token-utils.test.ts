/**
 * Token 估算和截断工具测试
 */

import { describe, test, expect } from "bun:test";
import { estimateTokens, truncateToLimit } from "../../src/config/token-utils.ts";
import type { Attachment } from "../../src/config/attachments.ts";

describe("estimateTokens", () => {
  test("空字符串返回 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("英文文本使用 ~3.5 字符/token", () => {
    const text = "Hello world, this is a test string for token estimation.";
    const tokens = estimateTokens(text);
    // 56 字符 / 3.5 ≈ 16
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(25);
  });

  test("中文文本使用 ~2.0 字符/token", () => {
    const text = "你好世界，这是一个用于测试的中文字符串，包含足够多的中文字符来触发中文检测。";
    const tokens = estimateTokens(text);
    // 中文字符占比高，使用 2.0 字符/token
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(40);
  });

  test("代码文本使用 ~3.0 字符/token", () => {
    const text = `function hello() { const x = 1; return x; } class Foo { constructor() {} }`;
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(35);
  });
});

describe("truncateToLimit", () => {
  const makeAttachment = (type: string, content: string, priority: number): Attachment => ({
    type,
    content,
    priority,
  });

  test("所有内容在限制内时全部保留", () => {
    const core = ["身份指令", "环境信息"];
    const attachments = [
      makeAttachment("rules", "项目规则", 10),
      makeAttachment("git", "Git 状态", 40),
    ];

    const result = truncateToLimit(core, attachments, 100000);
    expect(result).toContain("身份指令");
    expect(result).toContain("环境信息");
    expect(result).toContain("项目规则");
    expect(result).toContain("Git 状态");
  });

  test("超限时按优先级截断低优先级附件", () => {
    const core = ["A".repeat(100)];
    // 创建一个大附件，确保超限
    const bigContent = "B".repeat(10000);
    const attachments = [
      makeAttachment("important", "重要内容", 10),
      makeAttachment("big", bigContent, 40),
    ];

    // 设置很小的 token 限制
    const result = truncateToLimit(core, attachments, 100);
    expect(result).toContain("A".repeat(100));
    expect(result).toContain("重要内容");
    // 大附件应该被截断或丢弃
    expect(result).not.toContain(bigContent);
  });

  test("核心部分始终保留", () => {
    const core = ["核心内容必须保留"];
    const attachments = [
      makeAttachment("extra", "X".repeat(100000), 10),
    ];

    const result = truncateToLimit(core, attachments, 50);
    expect(result).toContain("核心内容必须保留");
  });
});
