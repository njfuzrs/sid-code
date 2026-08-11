/**
 * P0-1 Emacs kill ring + P0-2 删词 的 reducer 单测。
 *
 * 直接驱动导出的 textBufferReducer（纯函数），不拉起 React。
 * 覆盖：kill-line/kill-to-start 入环、kill-word-before 入环、yank 还原、
 * yank-pop 循环取更早条目、非 yank 动作打断序列后 yank-pop 失效。
 */

import { describe, test, expect } from "bun:test";
import {
  textBufferReducer as reduce,
  createInitialState,
  type TextBufferState,
} from "@sid-code/cli/ui/text-buffer.ts";

/** 从文本 + 光标列构造 state（单行场景）。 */
function stateAt(text: string, col: number): TextBufferState {
  const s = createInitialState(text);
  return { ...s, cursorRow: 0, cursorCol: col };
}

describe("kill ring — kill-line", () => {
  test("Ctrl+K 删到行尾并入环，Ctrl+Y 还原", () => {
    // "hello world"，光标在 6（world 前）
    let s = stateAt("hello world", 6);
    s = reduce(s, { type: "kill-line" });
    expect(s.lines[0]).toBe("hello ");
    expect(s.killRing).toEqual(["world"]);

    s = reduce(s, { type: "yank" });
    expect(s.lines[0]).toBe("hello world");
    expect(s.cursorCol).toBe(11);
  });

  test("空切片不入环", () => {
    // 光标已在行尾，kill-line 切走空串
    let s = stateAt("abc", 3);
    s = reduce(s, { type: "kill-line" });
    expect(s.killRing).toEqual([]);
  });
});

describe("kill ring — kill-to-start", () => {
  test("Ctrl+U 删到行首并入环", () => {
    let s = stateAt("hello world", 6);
    s = reduce(s, { type: "kill-to-start" });
    expect(s.lines[0]).toBe("world");
    expect(s.cursorCol).toBe(0);
    expect(s.killRing).toEqual(["hello "]);
  });
});

describe("kill ring — kill-word-before (Ctrl+W)", () => {
  test("删前一个词并入环", () => {
    let s = stateAt("foo bar baz", 11);
    s = reduce(s, { type: "kill-word-before" });
    expect(s.lines[0]).toBe("foo bar ");
    expect(s.killRing).toEqual(["baz"]);
  });

  test("行首 Ctrl+W 合并到上一行（不入环）", () => {
    let s = createInitialState("aa\nbb");
    s = { ...s, cursorRow: 1, cursorCol: 0 };
    s = reduce(s, { type: "kill-word-before" });
    expect(s.lines).toEqual(["aabb"]);
    expect(s.cursorRow).toBe(0);
    expect(s.cursorCol).toBe(2);
    expect(s.killRing).toEqual([]);
  });
});

describe("kill ring — yank / yank-pop", () => {
  test("连续两次 kill 后 Ctrl+Y 取最新", () => {
    // kill "world"（尾），再 kill "hello "（更早）
    let s = stateAt("hello world", 6);
    s = reduce(s, { type: "kill-line" });      // ring: ["world"]
    s = reduce(s, { type: "kill-to-start" });   // ring: ["world","hello "]
    expect(s.killRing).toEqual(["world", "hello "]);

    // 此时 lines[0]="" 光标 0；yank 取最新 "hello "
    s = reduce(s, { type: "yank" });
    expect(s.lines[0]).toBe("hello ");
    expect(s.lastActionWasYank).toBe(true);
  });

  test("Alt+Y yank-pop 循环取更早条目", () => {
    let s = stateAt("", 0);
    s = { ...s, killRing: ["AAA", "BBB", "CCC"], killRingIndex: -1 };
    // yank 取最新 CCC
    s = reduce(s, { type: "yank" });
    expect(s.lines[0]).toBe("CCC");
    // yank-pop：撤销 CCC，改插 BBB
    s = reduce(s, { type: "yank-pop" });
    expect(s.lines[0]).toBe("BBB");
    // 再 pop：改插 AAA
    s = reduce(s, { type: "yank-pop" });
    expect(s.lines[0]).toBe("AAA");
    // 再 pop：回绕到 CCC
    s = reduce(s, { type: "yank-pop" });
    expect(s.lines[0]).toBe("CCC");
  });

  test("非 yank 动作打断序列后 Alt+Y 不生效", () => {
    let s = stateAt("", 0);
    s = { ...s, killRing: ["AAA", "BBB"], killRingIndex: -1 };
    s = reduce(s, { type: "yank" });           // 插 BBB
    expect(s.lastActionWasYank).toBe(true);
    // 插入一个字符打断 yank 序列
    s = reduce(s, { type: "insert", text: "x" });
    expect(s.lastActionWasYank).toBe(false);
    const before = s.lines[0];
    // yank-pop 应 no-op（序列已断）
    s = reduce(s, { type: "yank-pop" });
    expect(s.lines[0]).toBe(before);
  });

  test("空 kill ring 时 yank / yank-pop 均 no-op", () => {
    let s = stateAt("abc", 3);
    s = reduce(s, { type: "yank" });
    expect(s.lines[0]).toBe("abc");
    s = reduce(s, { type: "yank-pop" });
    expect(s.lines[0]).toBe("abc");
  });
});

describe("kill ring — 跨提交保留", () => {
  test("reset 后 killRing 仍保留，可继续 yank", () => {
    let s = stateAt("hello world", 6);
    s = reduce(s, { type: "kill-line" });      // ring: ["world"]
    s = reduce(s, { type: "reset" });           // 提交清空输入
    expect(s.lines[0]).toBe("");
    expect(s.killRing).toEqual(["world"]);
    s = reduce(s, { type: "yank" });
    expect(s.lines[0]).toBe("world");
  });
});
