/**
 * Vim motions（P2-2）：计算光标目标位置的纯函数。
 *
 * 每个 motion 接受当前 buffer + count，返回目标 {row, col}。不修改 buffer。
 * operator（d/c/y）通过 motion 得到目标位置后，对 [起点, 终点) 区间做操作。
 *
 * 词边界语义对齐 vim 的 word（w/b/e）：连续的「词字符」或「标点符号」各算一个 word，
 * 空白分隔。这里用简化的两类（词字符 \w + 非空白标点），够日常用。
 */

import type { VimBuffer } from "./types.ts";

export interface Pos {
  row: number;
  col: number;
}

/** 字符分类：0=空白，1=词字符(字母数字下划线)，2=其它可见标点。 */
function charClass(ch: string): 0 | 1 | 2 {
  if (!ch || /\s/.test(ch)) return 0;
  if (/[\w一-龥]/.test(ch)) return 1;
  return 2;
}

/** h：左移 count 格（不跨行，夹到行首）。 */
export function motionLeft(buf: VimBuffer, count: number): Pos {
  return { row: buf.cursorRow, col: Math.max(0, buf.cursorCol - count) };
}

/** l：右移 count 格（不跨行，normal 下夹到行末字符上，即 len-1）。 */
export function motionRight(buf: VimBuffer, count: number): Pos {
  const line = buf.lines[buf.cursorRow] ?? "";
  const maxCol = Math.max(0, line.length - 1);
  return { row: buf.cursorRow, col: Math.min(maxCol, buf.cursorCol + count) };
}

/** j：下移 count 行，列夹到目标行末。 */
export function motionDown(buf: VimBuffer, count: number): Pos {
  const row = Math.min(buf.lines.length - 1, buf.cursorRow + count);
  const col = Math.min(buf.cursorCol, Math.max(0, (buf.lines[row] ?? "").length - 1));
  return { row, col };
}

/** k：上移 count 行。 */
export function motionUp(buf: VimBuffer, count: number): Pos {
  const row = Math.max(0, buf.cursorRow - count);
  const col = Math.min(buf.cursorCol, Math.max(0, (buf.lines[row] ?? "").length - 1));
  return { row, col };
}

/** 0：行首。 */
export function motionLineStart(buf: VimBuffer): Pos {
  return { row: buf.cursorRow, col: 0 };
}

/** $：行末（normal 下停在最后一个字符上）。count>1 时下移。 */
export function motionLineEnd(buf: VimBuffer, count: number): Pos {
  const row = Math.min(buf.lines.length - 1, buf.cursorRow + (count - 1));
  const line = buf.lines[row] ?? "";
  return { row, col: Math.max(0, line.length - 1) };
}

/** ^：行首第一个非空白字符。 */
export function motionFirstNonBlank(buf: VimBuffer): Pos {
  const line = buf.lines[buf.cursorRow] ?? "";
  let col = 0;
  while (col < line.length && /\s/.test(line[col])) col++;
  return { row: buf.cursorRow, col: Math.min(col, Math.max(0, line.length - 1)) };
}

/** w：下一个 word 起点（count 次）。 */
export function motionWordForward(buf: VimBuffer, count: number): Pos {
  let { cursorRow: row, cursorCol: col } = buf;
  for (let n = 0; n < count; n++) {
    const line = buf.lines[row] ?? "";
    const startClass = charClass(line[col]);
    // 跳过当前 word 的同类字符
    if (startClass !== 0) {
      while (col < line.length && charClass(line[col]) === startClass) col++;
    }
    // 跳过空白（可跨行）
    let curLine = buf.lines[row] ?? "";
    while (true) {
      while (col < curLine.length && charClass(curLine[col]) === 0) col++;
      if (col < curLine.length) break;
      if (row < buf.lines.length - 1) {
        row++;
        col = 0;
        curLine = buf.lines[row] ?? "";
      } else {
        col = Math.max(0, curLine.length - 1);
        break;
      }
    }
  }
  return { row, col };
}

/** b：上一个 word 起点（count 次）。 */
export function motionWordBackward(buf: VimBuffer, count: number): Pos {
  let { cursorRow: row, cursorCol: col } = buf;
  for (let n = 0; n < count; n++) {
    // 先后退一格（可跨行）
    if (col > 0) col--;
    else if (row > 0) {
      row--;
      col = Math.max(0, (buf.lines[row] ?? "").length - 1);
    }
    let line = buf.lines[row] ?? "";
    // 跳过空白（可跨行）
    while (charClass(line[col]) === 0) {
      if (col > 0) col--;
      else if (row > 0) {
        row--;
        line = buf.lines[row] ?? "";
        col = Math.max(0, line.length - 1);
      } else break;
    }
    // 退到该 word 的起点
    const cls = charClass(line[col]);
    while (col > 0 && charClass(line[col - 1]) === cls) col--;
  }
  return { row, col };
}

/** e：当前/下一个 word 的末尾（count 次）。 */
export function motionWordEnd(buf: VimBuffer, count: number): Pos {
  let { cursorRow: row, cursorCol: col } = buf;
  for (let n = 0; n < count; n++) {
    // 先前进一格（可跨行）
    const line0 = buf.lines[row] ?? "";
    if (col < line0.length - 1) col++;
    else if (row < buf.lines.length - 1) {
      row++;
      col = 0;
    }
    let line = buf.lines[row] ?? "";
    // 跳过空白
    while (charClass(line[col]) === 0) {
      if (col < line.length - 1) col++;
      else if (row < buf.lines.length - 1) {
        row++;
        line = buf.lines[row] ?? "";
        col = 0;
      } else break;
    }
    // 推进到该 word 末尾
    const cls = charClass(line[col]);
    while (col < line.length - 1 && charClass(line[col + 1]) === cls) col++;
  }
  return { row, col };
}

/** f/F/t/T：行内字符查找。kind 决定方向与是否停在字符前。找不到返回原位。 */
export function motionFind(
  buf: VimBuffer,
  kind: "f" | "F" | "t" | "T",
  ch: string,
  count: number,
): Pos {
  const line = buf.lines[buf.cursorRow] ?? "";
  let col = buf.cursorCol;
  const forward = kind === "f" || kind === "t";
  const till = kind === "t" || kind === "T";
  for (let n = 0; n < count; n++) {
    if (forward) {
      let i = col + 1;
      // t 连续重复时紧邻目标会原地卡住，从第二次起先跨过它（; 重复语义）。
      if (till && n > 0 && line[i] === ch && i < line.length) i++;
      while (i < line.length && line[i] !== ch) i++;
      if (i >= line.length) return { row: buf.cursorRow, col: buf.cursorCol };
      col = till ? i - 1 : i;
    } else {
      let i = col - 1;
      if (till && n > 0 && line[i] === ch && i >= 0) i--;
      while (i >= 0 && line[i] !== ch) i--;
      if (i < 0) return { row: buf.cursorRow, col: buf.cursorCol };
      col = till ? i + 1 : i;
    }
  }
  return { row: buf.cursorRow, col };
}

/** gg：跳到第 count 行行首第一个非空白（默认首行）。 */
export function motionBufferStart(buf: VimBuffer, count: number | null): Pos {
  const row = count && count > 0 ? Math.min(count - 1, buf.lines.length - 1) : 0;
  const line = buf.lines[row] ?? "";
  let col = 0;
  while (col < line.length && /\s/.test(line[col])) col++;
  return { row, col: Math.min(col, Math.max(0, line.length - 1)) };
}

/** G：跳到第 count 行（默认末行）行首第一个非空白。 */
export function motionBufferEnd(buf: VimBuffer, count: number | null): Pos {
  const row = count && count > 0 ? Math.min(count - 1, buf.lines.length - 1) : buf.lines.length - 1;
  const line = buf.lines[row] ?? "";
  let col = 0;
  while (col < line.length && /\s/.test(line[col])) col++;
  return { row, col: Math.min(col, Math.max(0, line.length - 1)) };
}
