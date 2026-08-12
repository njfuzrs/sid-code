/**
 * Token 估算和截断工具测试
 */

import { describe, test, expect } from "bun:test";
import { estimateTokens, truncateToLimit } from "@sid-code/core/config/token-utils.ts";
import { estimateTextTokens } from "@sid-code/core/context/token.ts";
import type { Attachment } from "@sid-code/core/config/attachments.ts";

describe("estimateTokens", () => {
  test("空字符串返回 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  // EST-1：estimateTokens 已收敛为复用 context/token.ts 的权威字符级估算
  // （ASCII 0.20 tok/char、非 ASCII 0.65 tok/char），不再自带分内容类型的系数。
  // 以下用例验证收敛后的统一口径，而非旧的"中文2.0/代码3.0/英文3.5字符每token"分档。

  test("英文文本：ASCII ~0.20 tok/char", () => {
    const text = "Hello world, this is a test string for token estimation.";
    const tokens = estimateTokens(text);
    // 56 字符 × 0.20 ≈ 11~12
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(18);
  });

  test("中文文本：非 ASCII ~0.65 tok/char", () => {
    const text = "你好世界，这是一个用于测试的中文字符串，包含足够多的中文字符来触发中文检测。";
    const tokens = estimateTokens(text);
    // 约 38 个非 ASCII 字符 × 0.65 ≈ 25 上下
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(35);
  });

  test("代码文本：ASCII ~0.20 tok/char", () => {
    const text = `function hello() { const x = 1; return x; } class Foo { constructor() {} }`;
    const tokens = estimateTokens(text);
    // 74 字符全 ASCII × 0.20 ≈ 15
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(25);
  });

  test("EST-1：与权威估算器 estimateTextTokens 完全一致", () => {
    const samples = [
      "Hello world",
      "你好世界，测试中文",
      "function f() { return 42; }",
      "mixed 混合 content 内容 123",
    ];
    for (const s of samples) {
      expect(estimateTokens(s)).toBe(estimateTextTokens(s));
    }
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
    expect(result.content).toContain("身份指令");
    expect(result.content).toContain("环境信息");
    expect(result.content).toContain("项目规则");
    expect(result.content).toContain("Git 状态");
    expect(result.included).toHaveLength(2);
    expect(result.discarded).toHaveLength(0);
    expect(result.truncated).toBeUndefined();
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
    expect(result.content).toContain("A".repeat(100));
    expect(result.content).toContain("重要内容");
    // 大附件应该被截断或丢弃
    expect(result.content).not.toContain(bigContent);
    // 结构化追踪
    expect(result.included.length + (result.truncated ? 1 : 0) + result.discarded.length).toBe(2);
  });

  test("核心部分始终保留", () => {
    const core = ["核心内容必须保留"];
    const attachments = [makeAttachment("extra", "X".repeat(100000), 10)];

    const result = truncateToLimit(core, attachments, 50);
    expect(result.content).toContain("核心内容必须保留");
  });

  test("返回结构化的截断追踪信息", () => {
    const core = ["核心"];
    const attachments = [
      makeAttachment("a", "小附件", 10),
      makeAttachment("b", "Y".repeat(50000), 20),
      makeAttachment("c", "被丢弃的附件", 30),
    ];

    const result = truncateToLimit(core, attachments, 200);
    // a 应该被包含
    expect(result.included.some((att) => att.type === "a")).toBe(true);
    // b 或 c 应该在 truncated 或 discarded 中
    const allTracked =
      result.included.length + (result.truncated ? 1 : 0) + result.discarded.length;
    expect(allTracked).toBe(3);
  });

  // 缺口1：截断路径的 DYNAMIC_BOUNDARY 保真
  describe("DYNAMIC_BOUNDARY 保真", () => {
    const BOUNDARY = "\n\n<!-- DYNAMIC_BOUNDARY -->\n\n";

    test("有附件保留时，boundary 插在静态区(coreParts)之后、附件之前", () => {
      const core = ["身份指令", "环境信息"];
      const attachments = [makeAttachment("git", "Git 状态", 40)];

      const result = truncateToLimit(core, attachments, 100000, BOUNDARY);
      expect(result.content).toContain(BOUNDARY);
      // 静态核心区在 boundary 之前
      const idx = result.content.indexOf(BOUNDARY);
      expect(result.content.slice(0, idx)).toContain("身份指令");
      expect(result.content.slice(0, idx)).toContain("环境信息");
      // 附件在 boundary 之后（动态区）
      expect(result.content.slice(idx)).toContain("Git 状态");
      // 静态区不含附件（易变内容不会被误缓存进静态区）
      expect(result.content.slice(0, idx)).not.toContain("Git 状态");
    });

    test("boundary 插入后无多余空行（不产生 4 个连续换行）", () => {
      const core = ["核心"];
      const attachments = [makeAttachment("git", "Git 状态", 40)];
      const result = truncateToLimit(core, attachments, 100000, BOUNDARY);
      // boundary 自带前后 \n\n，附件不应再补分隔，故整体不出现连续 4 个换行
      expect(result.content).not.toContain("\n\n\n\n");
    });

    test("所有附件被丢弃（纯 coreParts）时不插 boundary", () => {
      const core = ["核心内容必须保留"];
      const attachments = [makeAttachment("extra", "X".repeat(100000), 10)];
      const result = truncateToLimit(core, attachments, 50, BOUNDARY);
      expect(result.content).toContain("核心内容必须保留");
      // 无附件落入动态区 → 无需边界（与正常路径 dynamicParts.length===0 语义一致）
      expect(result.content).not.toContain(BOUNDARY);
    });

    test("被截断的附件也落在 boundary 之后", () => {
      const core = ["A".repeat(100)];
      const attachments = [makeAttachment("big", "B".repeat(10000), 40)];
      const result = truncateToLimit(core, attachments, 500, BOUNDARY);
      if (result.truncated) {
        const idx = result.content.indexOf(BOUNDARY);
        expect(idx).toBeGreaterThan(-1);
        // 截断内容在动态区
        expect(result.content.slice(idx)).toContain("[内容已截断]");
      }
    });

    test("不传 boundary 时退化为无边界拼接（向后兼容）", () => {
      const core = ["核心"];
      const attachments = [makeAttachment("git", "Git 状态", 40)];
      const result = truncateToLimit(core, attachments, 100000);
      expect(result.content).not.toContain(BOUNDARY);
      expect(result.content).toContain("核心");
      expect(result.content).toContain("Git 状态");
    });
  });
});
