/**
 * ScreenBuffer — TypedArray cell 存储
 *
 * 管理 Uint32Array(width * height * 4) 的 cell 存储。
 * 每个 cell 占 4 个 Uint32：char, fg, bg, flags。
 * 支持溢出字符（emoji/ZWJ）和宽字符续接。
 */

import {
  CELL_STRIDE,
  SLOT_CHAR,
  SLOT_FG,
  SLOT_BG,
  SLOT_FLAGS,
  FLAG_OVERFLOW,
  COLOR_DEFAULT,
} from "./constants.ts";

const SPACE = 0x20;
/** width=1 编码在 flags 的 bits 16-17 */
const WIDTH_SHIFT = 16;
const WIDTH_MASK = 0x3;
/** modifier flags 掩码（低 8 位） */
const MODS_MASK = 0xff;

export class ScreenBuffer {
  width: number;
  height: number;
  buffer: Uint32Array;
  /** 溢出字符存储（code point > 0xFFFF 或多码点字符） */
  overflow: Map<number, string>;
  private nextOverflowId = 1;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.buffer = new Uint32Array(width * height * CELL_STRIDE);
    this.overflow = new Map();
    this.clear();
  }

  /** 全部填充为空格 + 默认色 + width=1 */
  clear(): void {
    const len = this.width * this.height;
    const buf = this.buffer;
    for (let i = 0; i < len; i++) {
      const off = i * CELL_STRIDE;
      buf[off + SLOT_CHAR] = SPACE;
      buf[off + SLOT_FG] = COLOR_DEFAULT;
      buf[off + SLOT_BG] = COLOR_DEFAULT;
      buf[off + SLOT_FLAGS] = 1 << WIDTH_SHIFT; // width=1, mods=0
    }
    this.overflow.clear();
    this.nextOverflowId = 1;
  }

  /** 计算 cell 在 buffer 中的偏移 */
  private offset(x: number, y: number): number {
    return (y * this.width + x) * CELL_STRIDE;
  }

  /**
   * 设置单个 cell
   * @param charWidth 字符显示宽度（1 或 2），默认 1
   */
  setCell(
    x: number,
    y: number,
    char: string,
    fg: number = COLOR_DEFAULT,
    bg: number = COLOR_DEFAULT,
    mods: number = 0,
    charWidth: number = 1,
  ): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;

    const off = this.offset(x, y);
    const buf = this.buffer;

    // 编码字符
    let charCode: number;
    let flags = (mods & MODS_MASK) | ((charWidth & WIDTH_MASK) << WIDTH_SHIFT);

    if (char.length === 0) {
      charCode = SPACE;
    } else {
      const cp = char.codePointAt(0)!;
      // 单码点且在 BMP 内 → 直接存储
      if (char.length <= 2 && cp <= 0xffff && char.length === 1) {
        charCode = cp;
      } else {
        // 溢出：emoji、ZWJ 序列等
        const id = this.nextOverflowId++;
        this.overflow.set(id, char);
        charCode = id;
        flags |= FLAG_OVERFLOW;
      }
    }

    buf[off + SLOT_CHAR] = charCode;
    buf[off + SLOT_FG] = fg;
    buf[off + SLOT_BG] = bg;
    buf[off + SLOT_FLAGS] = flags;

    // 宽字符：x+1 标记为续接 cell（width=0, char=0）
    if (charWidth === 2 && x + 1 < this.width) {
      const off2 = this.offset(x + 1, y);
      buf[off2 + SLOT_CHAR] = 0;
      buf[off2 + SLOT_FG] = fg;
      buf[off2 + SLOT_BG] = bg;
      buf[off2 + SLOT_FLAGS] = (mods & MODS_MASK); // width=0
    }
  }

  /** 比较两个 buffer 在 (x, y) 处的 cell 是否相同 */
  cellEquals(other: ScreenBuffer, x: number, y: number): boolean {
    const off = this.offset(x, y);
    const a = this.buffer;
    const b = other.buffer;
    return (
      a[off + SLOT_CHAR] === b[off + SLOT_CHAR] &&
      a[off + SLOT_FG] === b[off + SLOT_FG] &&
      a[off + SLOT_BG] === b[off + SLOT_BG] &&
      a[off + SLOT_FLAGS] === b[off + SLOT_FLAGS]
    );
  }

  /** 获取 cell 的显示字符 */
  getSymbol(x: number, y: number): string {
    const off = this.offset(x, y);
    const flags = this.buffer[off + SLOT_FLAGS];
    const charCode = this.buffer[off + SLOT_CHAR];

    if (flags & FLAG_OVERFLOW) {
      return this.overflow.get(charCode) ?? " ";
    }
    if (charCode === 0) return ""; // 续接 cell
    return String.fromCodePoint(charCode);
  }

  /** 获取前景色 */
  getFg(x: number, y: number): number {
    return this.buffer[this.offset(x, y) + SLOT_FG];
  }

  /** 获取背景色 */
  getBg(x: number, y: number): number {
    return this.buffer[this.offset(x, y) + SLOT_BG];
  }

  /** 获取 modifier flags */
  getMods(x: number, y: number): number {
    return this.buffer[this.offset(x, y) + SLOT_FLAGS] & MODS_MASK;
  }

  /** 获取 cell 显示宽度（0=续接, 1=普通, 2=宽字符） */
  getCellWidth(x: number, y: number): number {
    return (this.buffer[this.offset(x, y) + SLOT_FLAGS] >> WIDTH_SHIFT) & WIDTH_MASK;
  }

  /** 矩形填充 */
  fillRect(
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    char: string = " ",
    fg: number = COLOR_DEFAULT,
    bg: number = COLOR_DEFAULT,
    mods: number = 0,
  ): void {
    const x0 = Math.max(0, rx);
    const y0 = Math.max(0, ry);
    const x1 = Math.min(this.width, rx + rw);
    const y1 = Math.min(this.height, ry + rh);

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        this.setCell(x, y, char, fg, bg, mods, 1);
      }
    }
  }

  /** 整块复制 */
  copyFrom(other: ScreenBuffer): void {
    if (this.width !== other.width || this.height !== other.height) {
      this.width = other.width;
      this.height = other.height;
      this.buffer = new Uint32Array(other.buffer.length);
    }
    this.buffer.set(other.buffer);
    // 复制 overflow map
    this.overflow.clear();
    for (const [k, v] of other.overflow) {
      this.overflow.set(k, v);
    }
    this.nextOverflowId = other.nextOverflowId;
  }

  /** 调整大小（内容清空） */
  resize(newWidth: number, newHeight: number): void {
    this.width = newWidth;
    this.height = newHeight;
    this.buffer = new Uint32Array(newWidth * newHeight * CELL_STRIDE);
    this.overflow.clear();
    this.nextOverflowId = 1;
    this.clear();
  }
}
