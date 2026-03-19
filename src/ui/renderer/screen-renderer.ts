/**
 * ScreenRenderer — 双缓冲 + 逐 cell 差分 + 最小化 ANSI 输出
 *
 * 维护 front（当前屏幕显示）和 back（下一帧目标）两个 ScreenBuffer，
 * flush() 时逐 cell 比较，只输出变化的部分。
 *
 * Alternate Screen 模式：
 * - Live 区域固定在屏幕底部，起始行由 liveStartRow 指定
 * - flush() 使用 CUP 绝对定位到 liveStartRow
 * - resize 时只需清屏重绘，无 scrollback reflow 问题
 *
 * 光标不变量：flush() 结束后，若找到 inverse cell（输入框光标），
 * 终端光标定位到该 cell 并可见（用于 IME）；否则隐藏在最后一行末尾。
 */

import { ScreenBuffer } from "./screen-buffer.ts";
import {
  COLOR_DEFAULT,
  MOD_BOLD,
  MOD_DIM,
  MOD_ITALIC,
  MOD_UNDERLINE,
  MOD_BLINK,
  MOD_REVERSE,
  MOD_HIDDEN,
  MOD_STRIKETHROUGH,
  HIDE_CURSOR,
  SHOW_CURSOR,
  RESET_STYLE,
  CUP,
  CUF,
} from "./constants.ts";

// @ts-ignore — ink 未在 exports 中暴露这些内部文件
import { shouldSynchronize, bsu, esu } from "../../../node_modules/ink/build/write-synchronized.js";

/** ESC[2K — 清除整行 */
const EL = "\x1b[2K";

export class ScreenRenderer {
  private front: ScreenBuffer;
  private back: ScreenBuffer;
  private stdout: NodeJS.WriteStream;

  /** ANSI 状态追踪（避免重复输出相同样式） */
  private lastFg: number = COLOR_DEFAULT;
  private lastBg: number = COLOR_DEFAULT;
  private lastMods: number = 0;

  /** Live 区域高度（上次 flush 的行数） */
  private liveHeight: number = 0;

  /** Live 区域在屏幕中的起始行（0-based），由 RenderController 设置 */
  private liveStartRow: number = 0;

  constructor(stdout: NodeJS.WriteStream, width: number = 80, height: number = 1) {
    this.stdout = stdout;
    this.front = new ScreenBuffer(width, height);
    this.back = new ScreenBuffer(width, height);
  }

  /** 获取 back buffer 供 Rasterizer 写入 */
  getBackBuffer(): ScreenBuffer {
    return this.back;
  }

  /** 获取 front buffer（调试用） */
  getFrontBuffer(): ScreenBuffer {
    return this.front;
  }

  /** 获取当前 Live 区域高度 */
  getLiveHeight(): number {
    return this.liveHeight;
  }

  /** 设置 Live 区域在屏幕中的起始行（0-based） */
  setLiveStartRow(row: number): void {
    this.liveStartRow = row;
  }

  /**
   * 逐 cell 差分输出
   *
   * Alternate Screen 模式下使用 CUP 绝对定位到 liveStartRow，
   * 逐行逐 cell 遍历，只输出变化的 cell。
   */
  flush(): void {
    const back = this.back;
    const front = this.front;
    const newHeight = back.height;
    const width = back.width;
    const out: string[] = [];

    const sync = shouldSynchronize(this.stdout);
    if (sync) out.push(bsu);
    out.push(HIDE_CURSOR);

    // 重置样式追踪
    this.lastFg = COLOR_DEFAULT;
    this.lastBg = COLOR_DEFAULT;
    this.lastMods = 0;

    // 需要比较的行数 = max(旧高度, 新高度)
    const compareHeight = Math.max(this.liveHeight, newHeight);
    // front buffer 可能尺寸不同，需要安全比较
    const frontHeight = front.height;
    const frontWidth = front.width;

    for (let y = 0; y < compareHeight; y++) {
      if (y >= newHeight) {
        // 多余的旧行：用 CUP 定位后清除
        out.push(CUP(this.liveStartRow + y, 0) + EL);
        continue;
      }

      // 检查这一行是否有变化
      let lineChanged = false;
      if (y >= frontHeight || width !== frontWidth) {
        lineChanged = true;
      } else {
        for (let x = 0; x < width; x++) {
          if (!front.cellEquals(back, x, y)) {
            lineChanged = true;
            break;
          }
        }
      }

      if (!lineChanged) continue;

      // 用 CUP 定位到这一行行首，然后清除整行
      out.push(CUP(this.liveStartRow + y, 0) + EL);

      // 找到这一行最后一个非空格 cell 的位置（避免输出尾部空格）
      let lastNonEmpty = -1;
      for (let x = width - 1; x >= 0; x--) {
        const sym = back.getSymbol(x, y);
        const bg = back.getBg(x, y);
        if (sym !== " " || bg !== COLOR_DEFAULT) {
          lastNonEmpty = x;
          break;
        }
      }

      if (lastNonEmpty < 0) continue; // 全空行

      let cursorX = 0;
      for (let x = 0; x <= lastNonEmpty; x++) {
        const cellWidth = back.getCellWidth(x, y);
        if (cellWidth === 0) continue; // 续接 cell，跳过

        const sym = back.getSymbol(x, y);
        const fg = back.getFg(x, y);
        const bg = back.getBg(x, y);
        const mods = back.getMods(x, y);

        // 空格 + 默认色 → 跳过（光标右移）
        if (sym === " " && fg === COLOR_DEFAULT && bg === COLOR_DEFAULT && mods === 0) {
          continue;
        }

        // 光标定位
        if (x > cursorX) {
          const gap = x - cursorX;
          out.push(CUF(gap));
        }

        // 样式变更
        this.emitStyle(out, fg, bg, mods);

        // 输出字符
        out.push(sym);
        cursorX = x + cellWidth;
      }
    }

    // 扫描 back buffer 找到第一个 inverse cell（输入框光标位置）
    let inversePos: { x: number; y: number } | null = null;
    for (let y = 0; y < newHeight && !inversePos; y++) {
      for (let x = 0; x < width; x++) {
        const mods = back.getMods(x, y);
        if (mods & MOD_REVERSE) {
          inversePos = { x, y };
          break;
        }
      }
    }

    if (inversePos) {
      // 用 CUP 绝对定位到 inverse cell（用于 IME 预编辑文本定位）
      out.push(CUP(this.liveStartRow + inversePos.y, inversePos.x));
      out.push(SHOW_CURSOR);
    } else {
      // 没有 inverse cell，光标隐藏在最后一行末尾
      if (newHeight > 0) {
        out.push(CUP(this.liveStartRow + newHeight - 1, back.width));
      }
    }

    // 重置样式
    out.push(RESET_STYLE);
    if (sync) out.push(esu);

    this.stdout.write(out.join(""));

    // 更新状态
    this.front.copyFrom(back);
    this.liveHeight = newHeight;
  }

  /**
   * 清除 Live 区域
   * 在 alternate screen 模式下用 CUP 绝对定位逐行清除。
   */
  clearLive(): void {
    if (this.liveHeight === 0) return;

    const out: string[] = [];
    for (let i = 0; i < this.liveHeight; i++) {
      out.push(CUP(this.liveStartRow + i, 0) + EL);
    }
    this.stdout.write(out.join(""));

    // 重置状态
    this.front.clear();
    this.liveHeight = 0;
  }

  /**
   * resize 专用清除 — alternate screen 模式下直接清屏
   *
   * alternate screen 没有 scrollback reflow 问题，
   * 直接清屏 + reset 即可，RenderController 会重绘消息区域和 Live 区域。
   */
  clearScreen(): void {
    // ESC[2J 清屏 + ESC[H 光标归位
    this.stdout.write("\x1b[2J\x1b[H");

    // 重置状态
    this.front.clear();
    this.liveHeight = 0;
    this.lastFg = COLOR_DEFAULT;
    this.lastBg = COLOR_DEFAULT;
    this.lastMods = 0;
  }

  /**
   * 调整 buffer 大小
   * front 清空，下次 flush 时 diff 会输出全部内容（等效全量重绘）。
   */
  resize(newWidth: number, newHeight: number): void {
    this.front.resize(newWidth, newHeight);
    this.back.resize(newWidth, newHeight);
    this.liveHeight = 0;
    this.lastFg = COLOR_DEFAULT;
    this.lastBg = COLOR_DEFAULT;
    this.lastMods = 0;
  }

  /**
   * 重置状态（不写入终端）
   */
  reset(): void {
    this.front.clear();
    this.back.clear();
    this.liveHeight = 0;
    this.lastFg = COLOR_DEFAULT;
    this.lastBg = COLOR_DEFAULT;
    this.lastMods = 0;
  }

  /** 输出 SGR 样式序列（只在变化时输出） */
  private emitStyle(out: string[], fg: number, bg: number, mods: number): void {
    if (fg === this.lastFg && bg === this.lastBg && mods === this.lastMods) {
      return;
    }

    // 如果 mods 减少了某些标志，需要先 reset 再重新设置
    const needReset = (this.lastMods & ~mods) !== 0;

    if (needReset) {
      out.push(RESET_STYLE);
      this.lastFg = COLOR_DEFAULT;
      this.lastBg = COLOR_DEFAULT;
      this.lastMods = 0;
    }

    const parts: string[] = [];

    // Modifiers
    if (mods !== this.lastMods) {
      const newMods = mods & ~this.lastMods;
      if (newMods & MOD_BOLD) parts.push("1");
      if (newMods & MOD_DIM) parts.push("2");
      if (newMods & MOD_ITALIC) parts.push("3");
      if (newMods & MOD_UNDERLINE) parts.push("4");
      if (newMods & MOD_BLINK) parts.push("5");
      if (newMods & MOD_REVERSE) parts.push("7");
      if (newMods & MOD_HIDDEN) parts.push("8");
      if (newMods & MOD_STRIKETHROUGH) parts.push("9");
    }

    // 前景色
    if (fg !== this.lastFg) {
      if (fg === COLOR_DEFAULT) {
        parts.push("39");
      } else {
        const r = (fg >> 16) & 0xff;
        const g = (fg >> 8) & 0xff;
        const b = fg & 0xff;
        parts.push(`38;2;${r};${g};${b}`);
      }
    }

    // 背景色
    if (bg !== this.lastBg) {
      if (bg === COLOR_DEFAULT) {
        parts.push("49");
      } else {
        const r = (bg >> 16) & 0xff;
        const g = (bg >> 8) & 0xff;
        const b = bg & 0xff;
        parts.push(`48;2;${r};${g};${b}`);
      }
    }

    if (parts.length > 0) {
      out.push(`\x1b[${parts.join(";")}m`);
    }

    this.lastFg = fg;
    this.lastBg = bg;
    this.lastMods = mods;
  }
}
