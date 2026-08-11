/**
 * MD2/ST3 — 单行高亮缓存测试
 *
 * 验证：
 * - 相同 (语言, 行文本) 重复高亮返回引用相等的缓存结果（流式重渲染不重复高亮）
 * - clearLineHighlightCache 清空后重新计算
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { colorizeLine, clearLineHighlightCache } from "@sid-code/cli/ui/components/CodeColorizer.tsx";

describe("MD2/ST3 — 单行高亮缓存", () => {
  beforeEach(() => {
    clearLineHighlightCache();
  });

  test("相同行重复高亮命中缓存（引用相等）", () => {
    const a = colorizeLine("const x = 1;", "javascript");
    const b = colorizeLine("const x = 1;", "javascript");
    // 命中缓存 → 同一个 React 元素引用
    expect(a).toBe(b);
  });

  test("不同语言不串用缓存", () => {
    const js = colorizeLine("x = 1", "javascript");
    const py = colorizeLine("x = 1", "python");
    expect(js).not.toBe(py);
  });

  test("不同行文本各自高亮", () => {
    const a = colorizeLine("foo()", "javascript");
    const b = colorizeLine("bar()", "javascript");
    expect(a).not.toBe(b);
  });

  test("清空缓存后重新计算（新引用）", () => {
    const a = colorizeLine("let y = 2;", "javascript");
    clearLineHighlightCache();
    const b = colorizeLine("let y = 2;", "javascript");
    // 缓存已清 → 重新计算，引用不同（但内容等价）
    expect(a).not.toBe(b);
  });
});
