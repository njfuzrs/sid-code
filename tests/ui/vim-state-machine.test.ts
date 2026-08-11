/**
 * Vim 引擎测试（P2-2）
 *
 * 覆盖新的 buffer-aware 引擎 reduceVimEngine：
 * 模式切换 / 移动(hjkl w b e 0 ^ $ gg G) / 编辑(x D dd) / operator+motion(dw d$ de) /
 * text object(diw ci" da() / f/F/t/T + ;, 重复 / count 前缀 / y+p 粘贴 / J / >> << / visual。
 */
import { describe, test, expect } from "bun:test";
import { reduceVimEngine } from "@sid-code/cli/ui/vim/transitions.ts";
import {
  INITIAL_ENGINE_STATE,
  type VimEngineState,
  type VimKey,
  type VimBuffer,
} from "@sid-code/cli/ui/vim/types.ts";

/** 造一个按键。单字符键 name 即字符；大写字母走 shift。 */
function k(name: string, extra: Partial<VimKey> = {}): VimKey {
  const shift = /^[A-Z]$/.test(name);
  return { name: shift ? name.toLowerCase() : name, sequence: name, ctrl: false, alt: false, shift, ...extra };
}

/** 从文本 + 光标构造缓冲。 */
function buf(text: string, row = 0, col = 0): VimBuffer {
  return { lines: text.split("\n"), cursorRow: row, cursorCol: col };
}

/** 连续喂多个键，返回最终 {buffer, state}。 */
function run(b: VimBuffer, keys: VimKey[], s: VimEngineState = INITIAL_ENGINE_STATE) {
  let buffer = b;
  let state = s;
  for (const key of keys) {
    const r = reduceVimEngine(buffer, state, key);
    buffer = r.buffer;
    state = r.state;
  }
  return { buffer, state };
}

describe("vim 引擎 - 模式切换", () => {
  test("i 进 insert，不消费后续字符", () => {
    const r = reduceVimEngine(buf("abc"), INITIAL_ENGINE_STATE, k("i"));
    expect(r.state.mode).toBe("insert");
    expect(r.consumed).toBe(true);
    const r2 = reduceVimEngine(r.buffer, r.state, k("x"));
    expect(r2.consumed).toBe(false); // insert 下透传
  });

  test("a 进 insert 且右移一格", () => {
    const r = reduceVimEngine(buf("abc", 0, 0), INITIAL_ENGINE_STATE, k("a"));
    expect(r.state.mode).toBe("insert");
    expect(r.buffer.cursorCol).toBe(1);
  });

  test("A 进 insert 且到行末", () => {
    const r = reduceVimEngine(buf("abc", 0, 0), INITIAL_ENGINE_STATE, k("A"));
    expect(r.buffer.cursorCol).toBe(3);
  });

  test("o 在下方开新行进 insert", () => {
    const r = reduceVimEngine(buf("a\nb", 0, 0), INITIAL_ENGINE_STATE, k("o"));
    expect(r.buffer.lines).toEqual(["a", "", "b"]);
    expect(r.buffer.cursorRow).toBe(1);
    expect(r.state.mode).toBe("insert");
  });

  test("insert Esc 回 normal 并左移一格", () => {
    const s: VimEngineState = { ...INITIAL_ENGINE_STATE, mode: "insert" };
    const r = reduceVimEngine(buf("abc", 0, 2), s, k("escape"));
    expect(r.state.mode).toBe("normal");
    expect(r.buffer.cursorCol).toBe(1);
  });
});

describe("vim 引擎 - 移动", () => {
  test("hjkl", () => {
    expect(run(buf("abc", 0, 1), [k("h")]).buffer.cursorCol).toBe(0);
    expect(run(buf("abc", 0, 0), [k("l")]).buffer.cursorCol).toBe(1);
    expect(run(buf("a\nb", 0, 0), [k("j")]).buffer.cursorRow).toBe(1);
    expect(run(buf("a\nb", 1, 0), [k("k")]).buffer.cursorRow).toBe(0);
  });

  test("0 ^ $", () => {
    expect(run(buf("  abc", 0, 4), [k("0")]).buffer.cursorCol).toBe(0);
    expect(run(buf("  abc", 0, 0), [k("^")]).buffer.cursorCol).toBe(2);
    expect(run(buf("abc", 0, 0), [k("$")]).buffer.cursorCol).toBe(2);
  });

  test("w b e 词移动", () => {
    expect(run(buf("foo bar baz", 0, 0), [k("w")]).buffer.cursorCol).toBe(4);
    expect(run(buf("foo bar baz", 0, 8), [k("b")]).buffer.cursorCol).toBe(4);
    expect(run(buf("foo bar", 0, 0), [k("e")]).buffer.cursorCol).toBe(2);
  });

  test("gg / G 到首尾行", () => {
    expect(run(buf("a\nb\nc", 2, 0), [k("g"), k("g")]).buffer.cursorRow).toBe(0);
    expect(run(buf("a\nb\nc", 0, 0), [k("G")]).buffer.cursorRow).toBe(2);
  });

  test("count 前缀：3l 右移三格", () => {
    expect(run(buf("abcdef", 0, 0), [k("3"), k("l")]).buffer.cursorCol).toBe(3);
  });

  test("count 前缀：2w 跳两个词", () => {
    expect(run(buf("a b c d", 0, 0), [k("2"), k("w")]).buffer.cursorCol).toBe(4);
  });
});

describe("vim 引擎 - 字符查找 f/F/t/T + ;/,", () => {
  test("fx 跳到下一个 x", () => {
    expect(run(buf("a.b.c", 0, 0), [k("f"), k(".")]).buffer.cursorCol).toBe(1);
  });
  test("Fx 反向查找", () => {
    expect(run(buf("a.b.c", 0, 4), [k("F"), k(".")]).buffer.cursorCol).toBe(3);
  });
  test("tx 停在目标前", () => {
    expect(run(buf("a.b.c", 0, 0), [k("t"), k(".")]).buffer.cursorCol).toBe(0);
  });
  test("; 重复上次 f", () => {
    const r = run(buf("a.b.c", 0, 0), [k("f"), k("."), k(";")]);
    expect(r.buffer.cursorCol).toBe(3);
  });
});

describe("vim 引擎 - 编辑命令", () => {
  test("x 删光标字符", () => {
    const r = run(buf("abc", 0, 0), [k("x")]);
    expect(r.buffer.lines[0]).toBe("bc");
  });
  test("3x 删三个字符", () => {
    const r = run(buf("abcdef", 0, 0), [k("3"), k("x")]);
    expect(r.buffer.lines[0]).toBe("def");
  });
  test("dd 删整行", () => {
    const r = run(buf("a\nb\nc", 1, 0), [k("d"), k("d")]);
    expect(r.buffer.lines).toEqual(["a", "c"]);
  });
  test("D 删到行末", () => {
    const r = run(buf("hello world", 0, 5), [k("D")]);
    expect(r.buffer.lines[0]).toBe("hello");
  });
  test("dw 删一个词", () => {
    const r = run(buf("foo bar", 0, 0), [k("d"), k("w")]);
    expect(r.buffer.lines[0]).toBe("bar");
  });
  test("d$ 删到行末", () => {
    const r = run(buf("hello world", 0, 5), [k("d"), k("$")]);
    expect(r.buffer.lines[0]).toBe("hello");
  });
  test("J 合并下一行", () => {
    const r = run(buf("foo\nbar", 0, 0), [k("J")]);
    expect(r.buffer.lines).toEqual(["foo bar"]);
  });
  test("~ 翻转大小写", () => {
    const r = run(buf("abc", 0, 0), [k("~")]);
    expect(r.buffer.lines[0]).toBe("Abc");
  });
});

describe("vim 引擎 - text objects", () => {
  test("diw 删词", () => {
    const r = run(buf("foo bar baz", 0, 5), [k("d"), k("i"), k("w")]);
    expect(r.buffer.lines[0]).toBe("foo  baz");
  });
  test('di" 删引号内容', () => {
    const r = run(buf('say "hello" now', 0, 6), [k("d"), k("i"), k('"')]);
    expect(r.buffer.lines[0]).toBe('say "" now');
  });
  test("da( 删括号含边界", () => {
    const r = run(buf("f(x, y) end", 0, 3), [k("d"), k("a"), k("(")]);
    expect(r.buffer.lines[0]).toBe("f end");
  });
  test('ci" 改引号内容进 insert', () => {
    const r = run(buf('v = "old"', 0, 6), [k("c"), k("i"), k('"')]);
    expect(r.buffer.lines[0]).toBe('v = ""');
    expect(r.state.mode).toBe("insert");
  });
});

describe("vim 引擎 - 复制粘贴", () => {
  test("yy + p 复制行并粘到下一行", () => {
    const r = run(buf("foo\nbar", 0, 0), [k("y"), k("y"), k("p")]);
    expect(r.buffer.lines).toEqual(["foo", "foo", "bar"]);
  });
  test("dd + p 删行并粘回", () => {
    const r = run(buf("a\nb\nc", 0, 0), [k("d"), k("d"), k("p")]);
    expect(r.buffer.lines).toEqual(["b", "a", "c"]);
  });
  test("x + p 交换字符", () => {
    const r = run(buf("ab", 0, 0), [k("x"), k("p")]);
    expect(r.buffer.lines[0]).toBe("ba");
  });
});

describe("vim 引擎 - 缩进", () => {
  test(">> 缩进当前行", () => {
    const r = run(buf("foo", 0, 0), [k(">"), k(">")]);
    expect(r.buffer.lines[0]).toBe("  foo");
  });
  test("<< 反缩进", () => {
    const r = run(buf("  foo", 0, 0), [k("<"), k("<")]);
    expect(r.buffer.lines[0]).toBe("foo");
  });
});

describe("vim 引擎 - visual 模式", () => {
  test("v 进 visual，选中后 d 删除", () => {
    // 在 "abcdef" 上从 0 选到 2（vl l），d 删除 inclusive [0,2] → "def"
    const r = run(buf("abcdef", 0, 0), [k("v"), k("l"), k("l"), k("d")]);
    expect(r.buffer.lines[0]).toBe("def");
    expect(r.state.mode).toBe("normal");
  });
  test("V 行选中后 d 删整行", () => {
    const r = run(buf("a\nb\nc", 0, 0), [k("V"), k("d")]);
    expect(r.buffer.lines).toEqual(["b", "c"]);
  });
  test("visual Esc 回 normal 不改缓冲", () => {
    const r = run(buf("abc", 0, 0), [k("v"), k("l"), k("escape")]);
    expect(r.state.mode).toBe("normal");
    expect(r.buffer.lines[0]).toBe("abc");
  });
});

describe("vim 引擎 - normal 吞字符", () => {
  test("normal 下乱敲可打印键不改文本", () => {
    const r = run(buf("abc", 0, 0), [k("z"), k("q")]);
    expect(r.buffer.lines[0]).toBe("abc");
  });
});
