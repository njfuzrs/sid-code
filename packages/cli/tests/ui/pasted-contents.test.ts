/**
 * IN3 粘贴内容跟踪单测
 *
 * 验证 pasted-contents：大块走占位、小块不占位、提交时还原、清空。
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  shouldPlaceholder,
  registerPaste,
  getPaste,
  listPastes,
  expandPastedRefs,
  clearPastes,
  PASTE_LINE_THRESHOLD,
  PASTE_CHAR_THRESHOLD,
} from "@sid-code/cli/ui/pasted-contents.ts";

describe("pasted-contents 粘贴跟踪", () => {
  beforeEach(() => clearPastes());

  test("小块文本不走占位", () => {
    expect(shouldPlaceholder("hello")).toBe(false);
    expect(shouldPlaceholder("a\nb\nc")).toBe(false);
  });

  test("超过行阈值走占位", () => {
    const many = Array.from({ length: PASTE_LINE_THRESHOLD + 2 }, () => "x").join("\n");
    expect(shouldPlaceholder(many)).toBe(true);
  });

  test("超过字符阈值走占位", () => {
    expect(shouldPlaceholder("x".repeat(PASTE_CHAR_THRESHOLD + 1))).toBe(true);
  });

  test("登记返回占位引用，多行显示行数", () => {
    const content = Array.from({ length: 42 }, (_, i) => `line ${i}`).join("\n");
    const ref = registerPaste(content);
    expect(ref).toBe("[粘贴 #1 +42 行]");
    const entry = getPaste(1);
    expect(entry?.content).toBe(content);
    expect(entry?.lineCount).toBe(42);
  });

  test("单行长文显示字符数", () => {
    const content = "x".repeat(1200);
    const ref = registerPaste(content);
    expect(ref).toBe("[粘贴 #1 1.2k 字符]");
  });

  test("id 自增", () => {
    expect(registerPaste("aaaaaaaa\n".repeat(10))).toContain("#1");
    expect(registerPaste("bbbbbbbb\n".repeat(10))).toContain("#2");
    expect(listPastes().length).toBe(2);
  });

  test("expandPastedRefs 还原占位为真实内容", () => {
    const content = "real\ncontent\nhere\n".repeat(5);
    const ref = registerPaste(content);
    const input = `请看这段:${ref} 谢谢`;
    expect(expandPastedRefs(input)).toBe(`请看这段:${content} 谢谢`);
  });

  test("expandPastedRefs 保留未登记的相似文本", () => {
    const input = "手敲的 [粘贴 #999 +5 行] 文本";
    expect(expandPastedRefs(input)).toBe(input);
  });

  test("还原多个占位", () => {
    const c1 = "AAAA\n".repeat(10);
    const c2 = "BBBB\n".repeat(10);
    const r1 = registerPaste(c1);
    const r2 = registerPaste(c2);
    expect(expandPastedRefs(`${r1}和${r2}`)).toBe(`${c1}和${c2}`);
  });

  test("clearPastes 后 id 重置且登记清空", () => {
    registerPaste("xxxx\n".repeat(10));
    clearPastes();
    expect(listPastes().length).toBe(0);
    expect(registerPaste("yyyy\n".repeat(10))).toContain("#1");
  });
});
