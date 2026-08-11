/**
 * Vim 专属 text-buffer reducer 动作单测（P1-4b）。
 *
 * 直接驱动纯函数 textBufferReducer，覆盖：
 * vim-delete-line（dd）/ vim-delete-to-line-end（D）/ vim-open-line（o·O）/ vim-move-line-first-nonblank（^）。
 */
import { describe, test, expect } from "bun:test";
import {
  textBufferReducer as reduce,
  createInitialState,
  type TextBufferState,
} from "@sid-code/cli/ui/text-buffer.ts";

/** 从多行文本 + 光标(row,col) 构造 state。 */
function stateAt(text: string, row: number, col: number): TextBufferState {
  const s = createInitialState(text);
  return { ...s, cursorRow: row, cursorCol: col };
}

describe("vim-delete-line (dd)", () => {
  test("删中间行，光标落到同下标行", () => {
    let s = stateAt("a\nb\nc", 1, 0);
    s = reduce(s, { type: "vim-delete-line" });
    expect(s.lines).toEqual(["a", "c"]);
    expect(s.cursorRow).toBe(1);
  });

  test("删末行，光标上移一行", () => {
    let s = stateAt("a\nb\nc", 2, 0);
    s = reduce(s, { type: "vim-delete-line" });
    expect(s.lines).toEqual(["a", "b"]);
    expect(s.cursorRow).toBe(1);
  });

  test("单行删空为一个空行", () => {
    let s = stateAt("only", 0, 2);
    s = reduce(s, { type: "vim-delete-line" });
    expect(s.lines).toEqual([""]);
    expect(s.cursorCol).toBe(0);
  });

  test("列夹到新行行末", () => {
    let s = stateAt("longline\nx", 0, 7);
    s = reduce(s, { type: "vim-delete-line" });
    expect(s.lines).toEqual(["x"]);
    expect(s.cursorCol).toBeLessThanOrEqual(1);
  });
});

describe("vim-delete-to-line-end (D)", () => {
  test("从光标删到行末", () => {
    let s = stateAt("hello world", 0, 5);
    s = reduce(s, { type: "vim-delete-to-line-end" });
    expect(s.lines[0]).toBe("hello");
  });

  test("光标在行首删整行内容", () => {
    let s = stateAt("abc", 0, 0);
    s = reduce(s, { type: "vim-delete-to-line-end" });
    expect(s.lines[0]).toBe("");
  });
});

describe("vim-open-line (o / O)", () => {
  test("o：下方开新行，光标到新行", () => {
    let s = stateAt("a\nb", 0, 1);
    s = reduce(s, { type: "vim-open-line", above: false });
    expect(s.lines).toEqual(["a", "", "b"]);
    expect(s.cursorRow).toBe(1);
    expect(s.cursorCol).toBe(0);
  });

  test("O：上方开新行，光标到新行", () => {
    let s = stateAt("a\nb", 1, 0);
    s = reduce(s, { type: "vim-open-line", above: true });
    expect(s.lines).toEqual(["a", "", "b"]);
    expect(s.cursorRow).toBe(1);
  });
});

describe("vim-move-line-first-nonblank (^)", () => {
  test("跳到行首第一个非空白字符", () => {
    let s = stateAt("    code", 0, 6);
    s = reduce(s, { type: "vim-move-line-first-nonblank" });
    expect(s.cursorCol).toBe(4);
  });

  test("全空白行跳到行末", () => {
    let s = stateAt("    ", 0, 0);
    s = reduce(s, { type: "vim-move-line-first-nonblank" });
    expect(s.cursorCol).toBe(4);
  });
});
