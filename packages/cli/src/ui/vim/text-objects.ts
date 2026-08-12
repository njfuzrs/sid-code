/**
 * Vim text objects（P2-2）：iw/aw、i"/a"、i'/a'、i(/a(、i[/a[、i{/a{、i</a<。
 *
 * 每个 text object 在当前光标处解析出一个字符区间 [start, end)（同一逻辑行内），
 * 供 operator（d/c/y）操作。跨行 text object（如 i{ 多行）暂只支持行内，够输入框日常用。
 *
 * i = inner（不含分隔符/边界空白），a = around（含分隔符，aw 额外含尾随空白）。
 */

import type { VimBuffer } from "./types.ts";

/** 行内字符区间（半开区间 [start, end)），row 标识所在逻辑行。 */
export interface Span {
  row: number;
  start: number;
  end: number;
}

const PAIRS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "<": ["<", ">"],
  ">": ["<", ">"],
};

const QUOTES = new Set(['"', "'", "`"]);

function charClass(ch: string): 0 | 1 | 2 {
  if (!ch || /\s/.test(ch)) return 0;
  if (/[\w一-龥]/.test(ch)) return 1;
  return 2;
}

/** iw/aw：词对象。around=true 时含尾随空白（无尾随空白则含前导空白）。 */
export function wordObject(buf: VimBuffer, around: boolean): Span | null {
  const row = buf.cursorRow;
  const line = buf.lines[row] ?? "";
  if (line.length === 0) return { row, start: 0, end: 0 };
  const col = Math.min(buf.cursorCol, line.length - 1);
  const cls = charClass(line[col]);
  let start = col;
  let end = col;
  while (start > 0 && charClass(line[start - 1]) === cls) start--;
  while (end < line.length - 1 && charClass(line[end + 1]) === cls) end++;
  end += 1; // 半开
  if (around) {
    // 含尾随空白
    let e = end;
    while (e < line.length && /\s/.test(line[e])) e++;
    if (e > end) {
      end = e;
    } else {
      // 无尾随空白 → 含前导空白
      while (start > 0 && /\s/.test(line[start - 1])) start--;
    }
  }
  return { row, start, end };
}

/** i"/a" 等引号对象：在当前行找包住光标（或光标右侧最近）的一对引号。 */
export function quoteObject(buf: VimBuffer, quote: string, around: boolean): Span | null {
  const row = buf.cursorRow;
  const line = buf.lines[row] ?? "";
  // 收集该行所有该引号的位置
  const positions: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === quote) positions.push(i);
  if (positions.length < 2) return null;
  // 找到包住光标的一对（或光标之后的第一对）
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const open = positions[i];
    const close = positions[i + 1];
    if (buf.cursorCol <= close) {
      if (around) return { row, start: open, end: close + 1 };
      return { row, start: open + 1, end: close };
    }
  }
  return null;
}

/** i(/a( 等括号对象：在当前行内匹配成对括号（支持嵌套）。 */
export function bracketObject(buf: VimBuffer, key: string, around: boolean): Span | null {
  const pair = PAIRS[key];
  if (!pair) return null;
  const [open, close] = pair;
  const row = buf.cursorRow;
  const line = buf.lines[row] ?? "";
  const col = buf.cursorCol;
  // 向左找未匹配的 open
  let depth = 0;
  let openIdx = -1;
  for (let i = col; i >= 0; i--) {
    if (line[i] === close && i !== col) depth++;
    else if (line[i] === open) {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx < 0) return null;
  // 从 open 向右找匹配的 close
  depth = 0;
  let closeIdx = -1;
  for (let i = openIdx + 1; i < line.length; i++) {
    if (line[i] === open) depth++;
    else if (line[i] === close) {
      if (depth === 0) {
        closeIdx = i;
        break;
      }
      depth--;
    }
  }
  if (closeIdx < 0) return null;
  if (around) return { row, start: openIdx, end: closeIdx + 1 };
  return { row, start: openIdx + 1, end: closeIdx };
}

/** 统一解析：i/a + 对象类型键 → Span。未识别返回 null。 */
export function resolveTextObject(buf: VimBuffer, variant: "i" | "a", objKey: string): Span | null {
  const around = variant === "a";
  if (objKey === "w" || objKey === "W") return wordObject(buf, around);
  if (QUOTES.has(objKey)) return quoteObject(buf, objKey, around);
  if (PAIRS[objKey]) return bracketObject(buf, objKey, around);
  return null;
}
