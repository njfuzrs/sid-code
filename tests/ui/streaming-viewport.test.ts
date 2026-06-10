/**
 * 流式视口裁剪纯函数单测（ADR-040 防闪烁，见 src/ui/streaming-viewport.ts）
 *
 * 守的核心不变量：动态区流式内容经裁剪后渲染高度 <= 预算，
 * 从而保证「动态区高度 < 终端行数」，规避 stock ink 的 clearTerminal 每帧重打。
 */

import { describe, test, expect } from "bun:test";
import {
  wrappedHeight,
  tailToFit,
  estimateChromeLines,
  computeStreamBudgets,
} from "../../src/ui/streaming-viewport.ts";

describe("wrappedHeight（软换行行数估算）", () => {
  test("空串算 1 行（一个空逻辑行）", () => {
    expect(wrappedHeight("", 80)).toBe(1);
  });

  test("单短行 = 1", () => {
    expect(wrappedHeight("hello", 80)).toBe(1);
  });

  test("多逻辑行累加，空行算 1", () => {
    expect(wrappedHeight("a\n\nb", 80)).toBe(3);
  });

  test("超宽行按宽度软换行向上取整", () => {
    expect(wrappedHeight("x".repeat(100), 40)).toBe(3); // ceil(100/40)=3
  });
});

describe("tailToFit（尾部截断到不超高）", () => {
  test("maxLines<=0 → 空串", () => {
    expect(tailToFit("a\nb\nc", 80, 0)).toBe("");
    expect(tailToFit("a\nb\nc", 80, -5)).toBe("");
  });

  test("内容本就放得下 → 原样返回", () => {
    expect(tailToFit("a\nb\nc", 80, 10)).toBe("a\nb\nc");
  });

  test("超预算 → 只保留尾部能放下的逻辑行", () => {
    const out = tailToFit("l1\nl2\nl3\nl4\nl5", 80, 2);
    expect(out).toBe("l4\nl5");
    expect(wrappedHeight(out, 80)).toBeLessThanOrEqual(2);
  });

  test("截断结果渲染高度恒 <= maxLines（关键不变量）", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
    for (const maxLines of [1, 3, 5, 10, 20]) {
      const out = tailToFit(text, 80, maxLines);
      expect(wrappedHeight(out, 80)).toBeLessThanOrEqual(maxLines);
    }
  });

  test("单条超长逻辑行 → 字符级尾部硬截断，仍不超高", () => {
    const longLine = "x".repeat(500);
    const out = tailToFit(longLine, 40, 2);
    // 取末尾后缀，渲染高度 <= 2
    expect(wrappedHeight(out, 40)).toBeLessThanOrEqual(2);
    expect(out.length).toBeGreaterThan(0);
    expect(longLine.endsWith(out)).toBe(true); // 是尾部后缀
  });

  test("保留的是尾部而非头部（流式应显示最新内容）", () => {
    const out = tailToFit("old1\nold2\nnew1\nnew2", 80, 2);
    expect(out).toContain("new2");
    expect(out).not.toContain("old1");
  });
});

describe("estimateChromeLines（底部 chrome 预留）", () => {
  test("基础预留为正且偏保守", () => {
    const base = estimateChromeLines({ todoCount: 0, taskCount: 0, hasStatusMessage: false });
    expect(base).toBeGreaterThanOrEqual(8);
  });

  test("todo / task / status 增加预留", () => {
    const withExtras = estimateChromeLines({ todoCount: 3, taskCount: 2, hasStatusMessage: true });
    const base = estimateChromeLines({ todoCount: 0, taskCount: 0, hasStatusMessage: false });
    expect(withExtras).toBeGreaterThan(base);
  });
});

describe("computeStreamBudgets（正文/思考行预算分配）", () => {
  test("仅正文 → 正文独占可用高度", () => {
    const { thinkingLines, textLines } = computeStreamBudgets(40, 8, false, true);
    expect(thinkingLines).toBe(0);
    expect(textLines).toBe(32);
  });

  test("仅思考 → 思考独占", () => {
    const { thinkingLines, textLines } = computeStreamBudgets(40, 8, true, false);
    expect(textLines).toBe(0);
    expect(thinkingLines).toBe(32);
  });

  test("正文+思考并存 → 思考约 1/3、正文取其余且二者之和 <= 可用", () => {
    const rows = 40, chrome = 8;
    const { thinkingLines, textLines } = computeStreamBudgets(rows, chrome, true, true);
    expect(thinkingLines).toBeGreaterThanOrEqual(2);
    expect(textLines).toBeGreaterThanOrEqual(3);
    expect(thinkingLines + textLines).toBeLessThanOrEqual(rows - chrome);
  });

  test("终端极矮 → 仍给最小可用行（不为 0）", () => {
    const { textLines } = computeStreamBudgets(5, 8, false, true);
    expect(textLines).toBeGreaterThanOrEqual(3);
  });

  test("都没有 → 全 0", () => {
    expect(computeStreamBudgets(40, 8, false, false)).toEqual({ thinkingLines: 0, textLines: 0 });
  });
});
