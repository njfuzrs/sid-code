/**
 * Vim operators（P2-2）：在缓冲上执行删除/复制/改写/粘贴/缩进等的纯函数。
 *
 * 约定：所有函数接受 VimBuffer + 参数，返回 { buffer, yanked?, linewise? }。
 * 光标定位遵循 vim 语义（删除后停在合理位置）。跨行区间按「行内优先、必要时跨行」处理。
 */

import type { VimBuffer } from "./types.ts";
import type { Pos } from "./motions.ts";
import type { Span } from "./text-objects.ts";

export interface OpResult {
  buffer: VimBuffer;
  /** 被 y/d/c/x 捕获的文本（供寄存器）。 */
  yanked?: string;
  /** 捕获内容是否整行（yy/dd）。 */
  linewise?: boolean;
}

const INDENT = "  "; // >> / << 缩进单位（2 空格，对齐项目风格）

/** 把光标位置与目标位置规整为 [from, to)（同序，跨行按行列比较）。含终点由调用方决定。 */
function orderPos(a: Pos, b: Pos): [Pos, Pos] {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
  return [b, a];
}

/** 抽取行内区间 [start, end) 文本。 */
function sliceLine(line: string, start: number, end: number): string {
  return line.slice(start, end);
}

/** x：删光标处 count 个字符（行内），返回被删文本。 */
export function deleteChars(buf: VimBuffer, count: number): OpResult {
  const line = buf.lines[buf.cursorRow] ?? "";
  if (line.length === 0) return { buffer: buf, yanked: "" };
  const start = buf.cursorCol;
  const end = Math.min(line.length, start + count);
  const yanked = sliceLine(line, start, end);
  const newLine = line.slice(0, start) + line.slice(end);
  const lines = [...buf.lines];
  lines[buf.cursorRow] = newLine;
  const col = Math.min(start, Math.max(0, newLine.length - 1));
  return { buffer: { lines, cursorRow: buf.cursorRow, cursorCol: col }, yanked, linewise: false };
}

/**
 * 删除一个 motion 区间。inclusive=true 时终点字符也删（f/t/e 等 inclusive motion）。
 * 跨行时合并首尾行。
 */
export function deleteRange(buf: VimBuffer, target: Pos, inclusive: boolean): OpResult {
  const from: Pos = { row: buf.cursorRow, col: buf.cursorCol };
  const [a, b0] = orderPos(from, target);
  const b = inclusive ? { row: b0.row, col: b0.col + 1 } : b0;
  const lines = [...buf.lines];
  if (a.row === b.row) {
    const line = lines[a.row] ?? "";
    const yanked = sliceLine(line, a.col, b.col);
    lines[a.row] = line.slice(0, a.col) + line.slice(b.col);
    const col = Math.min(a.col, Math.max(0, lines[a.row].length - 1));
    return { buffer: { lines, cursorRow: a.row, cursorCol: col }, yanked, linewise: false };
  }
  // 跨行：捕获 a.row 尾 + 中间整行 + b.row 头
  const first = lines[a.row] ?? "";
  const last = lines[b.row] ?? "";
  const captured: string[] = [first.slice(a.col)];
  for (let r = a.row + 1; r < b.row; r++) captured.push(lines[r] ?? "");
  captured.push(last.slice(0, b.col));
  const merged = first.slice(0, a.col) + last.slice(b.col);
  lines.splice(a.row, b.row - a.row + 1, merged);
  const col = Math.min(a.col, Math.max(0, merged.length - 1));
  return { buffer: { lines, cursorRow: a.row, cursorCol: col }, yanked: captured.join("\n"), linewise: false };
}

/** 复制一个 motion 区间（不改缓冲，仅捕获 yanked + 定位光标到区间起点）。 */
export function yankRange(buf: VimBuffer, target: Pos, inclusive: boolean): OpResult {
  const from: Pos = { row: buf.cursorRow, col: buf.cursorCol };
  const [a, b0] = orderPos(from, target);
  const b = inclusive ? { row: b0.row, col: b0.col + 1 } : b0;
  if (a.row === b.row) {
    const line = buf.lines[a.row] ?? "";
    return { buffer: { ...buf, cursorRow: a.row, cursorCol: a.col }, yanked: sliceLine(line, a.col, b.col), linewise: false };
  }
  const captured: string[] = [(buf.lines[a.row] ?? "").slice(a.col)];
  for (let r = a.row + 1; r < b.row; r++) captured.push(buf.lines[r] ?? "");
  captured.push((buf.lines[b.row] ?? "").slice(0, b.col));
  return { buffer: { ...buf, cursorRow: a.row, cursorCol: a.col }, yanked: captured.join("\n"), linewise: false };
}

/** 删除一个 text object span（行内）。 */
export function deleteSpan(buf: VimBuffer, span: Span): OpResult {
  const line = buf.lines[span.row] ?? "";
  const yanked = sliceLine(line, span.start, span.end);
  const lines = [...buf.lines];
  lines[span.row] = line.slice(0, span.start) + line.slice(span.end);
  const col = Math.min(span.start, Math.max(0, lines[span.row].length - 1));
  return { buffer: { lines, cursorRow: span.row, cursorCol: col }, yanked, linewise: false };
}

/** 复制一个 text object span。 */
export function yankSpan(buf: VimBuffer, span: Span): OpResult {
  const line = buf.lines[span.row] ?? "";
  return { buffer: { ...buf, cursorRow: span.row, cursorCol: span.start }, yanked: sliceLine(line, span.start, span.end), linewise: false };
}

/** dd：删 count 整行，返回整行文本（linewise）。 */
export function deleteLines(buf: VimBuffer, count: number): OpResult {
  const start = buf.cursorRow;
  const end = Math.min(buf.lines.length, start + count);
  const captured = buf.lines.slice(start, end).join("\n");
  let lines = [...buf.lines];
  lines.splice(start, end - start);
  if (lines.length === 0) lines = [""];
  const row = Math.min(start, lines.length - 1);
  // 光标到该行第一个非空白
  const line = lines[row] ?? "";
  let col = 0;
  while (col < line.length && /\s/.test(line[col])) col++;
  return { buffer: { lines, cursorRow: row, cursorCol: Math.min(col, Math.max(0, line.length - 1)) }, yanked: captured, linewise: true };
}

/** yy：复制 count 整行（linewise）。 */
export function yankLines(buf: VimBuffer, count: number): OpResult {
  const start = buf.cursorRow;
  const end = Math.min(buf.lines.length, start + count);
  return { buffer: buf, yanked: buf.lines.slice(start, end).join("\n"), linewise: true };
}

/** D / d$：从光标删到行末。 */
export function deleteToLineEnd(buf: VimBuffer): OpResult {
  const line = buf.lines[buf.cursorRow] ?? "";
  const yanked = line.slice(buf.cursorCol);
  const lines = [...buf.lines];
  lines[buf.cursorRow] = line.slice(0, buf.cursorCol);
  const col = Math.max(0, Math.min(buf.cursorCol, lines[buf.cursorRow].length - 1));
  return { buffer: { lines, cursorRow: buf.cursorRow, cursorCol: col }, yanked, linewise: false };
}

/** p / P：粘贴寄存器。after=true 为 p（光标后/下行），false 为 P（光标前/上行）。 */
export function paste(buf: VimBuffer, register: string, linewise: boolean, after: boolean): VimBuffer {
  if (!register) return buf;
  const lines = [...buf.lines];
  if (linewise) {
    const insertRows = register.split("\n");
    const at = after ? buf.cursorRow + 1 : buf.cursorRow;
    lines.splice(at, 0, ...insertRows);
    return { lines, cursorRow: at, cursorCol: 0 };
  }
  // 字符级：插到光标后(after)或当前列(before)
  const line = lines[buf.cursorRow] ?? "";
  const col = after ? Math.min(line.length, buf.cursorCol + 1) : buf.cursorCol;
  if (register.includes("\n")) {
    // 多行字符级粘贴：拆分当前行
    const head = line.slice(0, col);
    const tail = line.slice(col);
    const pieces = register.split("\n");
    const newLines = [head + pieces[0], ...pieces.slice(1, -1), pieces[pieces.length - 1] + tail];
    lines.splice(buf.cursorRow, 1, ...newLines);
    return { lines, cursorRow: buf.cursorRow + pieces.length - 1, cursorCol: Math.max(0, pieces[pieces.length - 1].length) };
  }
  lines[buf.cursorRow] = line.slice(0, col) + register + line.slice(col);
  return { lines, cursorRow: buf.cursorRow, cursorCol: col + register.length - 1 };
}

/** J：把下一行并到当前行末（中间用一个空格连接，vim 语义）。count 次。 */
export function joinLines(buf: VimBuffer, count: number): VimBuffer {
  const lines = [...buf.lines];
  const times = Math.max(1, count - 1) || 1;
  let joinCount = count <= 1 ? 1 : count - 1;
  let cursorCol = (lines[buf.cursorRow] ?? "").length;
  for (let n = 0; n < joinCount; n++) {
    if (buf.cursorRow >= lines.length - 1) break;
    const cur = lines[buf.cursorRow] ?? "";
    const next = (lines[buf.cursorRow + 1] ?? "").replace(/^\s+/, "");
    cursorCol = cur.length;
    const sep = cur.length > 0 && next.length > 0 ? " " : "";
    lines[buf.cursorRow] = cur + sep + next;
    lines.splice(buf.cursorRow + 1, 1);
  }
  void times;
  return { lines, cursorRow: buf.cursorRow, cursorCol: Math.min(cursorCol, Math.max(0, (lines[buf.cursorRow] ?? "").length - 1)) };
}

/** >> / <<：对 count 行做缩进/反缩进。indent=true 加一级，false 减一级。 */
export function indentLines(buf: VimBuffer, count: number, indent: boolean): VimBuffer {
  const lines = [...buf.lines];
  const start = buf.cursorRow;
  const end = Math.min(lines.length, start + Math.max(1, count));
  for (let r = start; r < end; r++) {
    if (indent) lines[r] = INDENT + lines[r];
    else lines[r] = lines[r].replace(new RegExp(`^( {1,${INDENT.length}}|\t)`), "");
  }
  const line = lines[start] ?? "";
  let col = 0;
  while (col < line.length && /\s/.test(line[col])) col++;
  return { lines, cursorRow: start, cursorCol: Math.min(col, Math.max(0, line.length - 1)) };
}

/** ~ ：翻转光标处字符大小写并右移。 */
export function toggleCase(buf: VimBuffer, count: number): VimBuffer {
  const line = buf.lines[buf.cursorRow] ?? "";
  if (line.length === 0) return buf;
  const chars = [...line];
  let col = buf.cursorCol;
  for (let n = 0; n < count && col < chars.length; n++, col++) {
    const c = chars[col];
    chars[col] = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
  }
  const lines = [...buf.lines];
  lines[buf.cursorRow] = chars.join("");
  return { lines, cursorRow: buf.cursorRow, cursorCol: Math.min(col, Math.max(0, lines[buf.cursorRow].length - 1)) };
}
