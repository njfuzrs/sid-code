/**
 * ScreenRenderer — 双缓冲 + 逐 cell 差分 + 最小化 ANSI 输出
 *
 * 维护 front（当前屏幕显示）和 back（下一帧目标）两个 ScreenBuffer，
 * flush() 时逐 cell 比较，只输出变化的部分。
 *
 * 光标不变量：flush() 结束后光标在 Live 区域最后一行末尾。
 */

import { ScreenBuffer } from "./screen-buffer.ts";
import {
  CELL_STRIDE,
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
  CUU,
  CUD,
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

  /**
   * 逐 cell 差分输出
   *
   * 算法：
   * 1. BSU + HIDE_CURSOR
   * 2. 光标从 Live 区域末尾移到第一行
   * 3. 逐行逐 cell 遍历，只输出变化的 cell
   * 4. 处理行数变化（增加/减少）
   * 5. RESET_STYLE + SHOW_CURSOR + ESU
   * 6. front.copyFrom(back)
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

    // 光标当前在 Live 区域最后一行末尾（不变量保证）
    // 移到 Live 区域第一行
    if (this.liveHeight > 1) {
      out.push(CUU(this.liveHeight - 1));
    }
    out.push("\r"); // 回到行首

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
      if (y > 0) {
        out.push("\r\n");
      }

      if (y >= newHeight) {
        // 多余的旧行：清除
        out.push(EL);
        continue;
      }

      // 检查这一行是否有变化
      let lineChanged = false;
      if (y >= frontHeight || width !== frontWidth) {
        // front 没有这一行或宽度不同 → 整行变化
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

      // 这一行有变化，逐 cell 输出
      // 先清除整行，然后输出非空内容
      out.push(EL);

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

    // 确保光标在最后一行
    // 当前光标在 compareHeight-1 行，需要移到 newHeight-1 行
    if (newHeight < compareHeight) {
      // 行数减少，光标需要上移
      const moveUp = compareHeight - newHeight;
      if (moveUp > 0) {
        out.push(CUU(moveUp));
      }
    }

    // 重置样式 + 显示光标
    out.push(RESET_STYLE + SHOW_CURSOR);
    if (sync) out.push(esu);

    this.stdout.write(out.join(""));

    // 更新状态
    this.front.copyFrom(back);
    this.liveHeight = newHeight;
  }

  /**
   * 清除 Live 区域（用于 Static 输出前）
   *
   * 光标不变量：调用结束后光标在 Live 区域第一行行首。
   */
  clearLive(): void {
    if (this.liveHeight === 0) return;

    const out: string[] = [];

    // 光标在最后一行末尾 → 逐行上移清除
    for (let i = this.liveHeight - 1; i >= 0; i--) {
      out.push("\r" + EL);
      if (i > 0) {
        out.push(CUU(1));
      }
    }

    this.stdout.write(out.join(""));

    // 重置 front buffer
    this.front.clear();
    this.liveHeight = 0;
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

  /**
   * 同步状态（外部直接写入后，告知 renderer 当前 Live 区域高度）
   */
  syncLiveHeight(height: number): void {
    this.liveHeight = height;
  }

  /** 输出 SGR 样式序列（只在变化时输出） */
  private emitStyle(out: string[], fg: number, bg: number, mods: number): void {
    if (fg === this.lastFg && bg === this.lastBg && mods === this.lastMods) {
      return;
    }

    // 如果 mods 减少了某些标志，需要先 reset 再重新设置
    const modsRemoved = (this.lastMods & ~mods) !== 0;
    const needReset =
      modsRemoved ||
      (this.lastFg !== COLOR_DEFAULT && fg === COLOR_DEFAULT && this.lastBg !== COLOR_DEFAULT && bg === COLOR_DEFAULT);

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
