/**
 * ANSI 样式解析器
 *
 * 将 @alcalzone/ansi-tokenize 的 StyledChar 转换为 ScreenBuffer 的 cell 属性。
 * 支持 SGR 参数解析、颜色转换、styled chars 写入。
 */

import { tokenize, styledCharsFromTokens, type StyledChar } from "@alcalzone/ansi-tokenize";
import stringWidth from "string-width";
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
} from "./constants.ts";
import type { ScreenBuffer } from "./screen-buffer.ts";

// 8 色基本色表（ANSI 30-37, 40-47）
const BASIC_COLORS = [
  0x000000, // 黑
  0xaa0000, // 红
  0x00aa00, // 绿
  0xaa5500, // 黄
  0x0000aa, // 蓝
  0xaa00aa, // 品红
  0x00aaaa, // 青
  0xaaaaaa, // 白
];

// 8 色亮色表（ANSI 90-97, 100-107）
const BRIGHT_COLORS = [
  0x555555, // 亮黑（灰）
  0xff5555, // 亮红
  0x55ff55, // 亮绿
  0xffff55, // 亮黄
  0x5555ff, // 亮蓝
  0xff55ff, // 亮品红
  0x55ffff, // 亮青
  0xffffff, // 亮白
];

// 256 色表（ANSI 38;5;N / 48;5;N）
function get256Color(n: number): number {
  if (n < 16) {
    // 0-7: 基本色, 8-15: 亮色
    return n < 8 ? BASIC_COLORS[n] : BRIGHT_COLORS[n - 8];
  }
  if (n < 232) {
    // 16-231: 6×6×6 RGB 立方体
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const toRgb = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return (toRgb(r) << 16) | (toRgb(g) << 8) | toRgb(b);
  }
  // 232-255: 灰度
  const gray = 8 + (n - 232) * 10;
  return (gray << 16) | (gray << 8) | gray;
}

/**
 * 解析 Ink 颜色格式为 0x00RRGGBB
 * 支持：named color, hex, rgb(), ansi256
 */
export function resolveInkColor(color: string | undefined): number {
  if (!color) return COLOR_DEFAULT;

  // hex: #RRGGBB 或 #RGB
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return (r << 16) | (g << 8) | b;
    }
    if (hex.length === 6) {
      return parseInt(hex, 16);
    }
  }

  // rgb(r, g, b)
  const rgbMatch = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    return (r << 16) | (g << 8) | b;
  }

  // ansi256(n)
  const ansi256Match = /^ansi256\((\d+)\)$/.exec(color);
  if (ansi256Match) {
    return get256Color(parseInt(ansi256Match[1], 10));
  }

  // named colors（chalk 支持的命名颜色）
  const namedColors: Record<string, number> = {
    black: 0x000000,
    red: 0xaa0000,
    green: 0x00aa00,
    yellow: 0xaa5500,
    blue: 0x0000aa,
    magenta: 0xaa00aa,
    cyan: 0x00aaaa,
    white: 0xaaaaaa,
    gray: 0x555555,
    grey: 0x555555,
    blackBright: 0x555555,
    redBright: 0xff5555,
    greenBright: 0x55ff55,
    yellowBright: 0xffff55,
    blueBright: 0x5555ff,
    magentaBright: 0xff55ff,
    cyanBright: 0x55ffff,
    whiteBright: 0xffffff,
  };

  return namedColors[color] ?? COLOR_DEFAULT;
}

/**
 * 从 ANSI code 字符串中提取 SGR 参数
 * @param code ANSI code 字符串，如 "\x1b[1;31m"
 * @returns SGR 参数数组，如 [1, 31]
 */
function extractSgrParams(code: string): number[] {
  // 匹配 \x1b[...m 格式
  const match = /\x1b\[([0-9;]+)m/.exec(code);
  if (!match) return [];
  return match[1].split(";").map((s) => parseInt(s, 10));
}

/**
 * 解析 ANSI SGR 参数为 cell 属性
 * @param styles StyledChar.styles 数组（来自 @alcalzone/ansi-tokenize）
 * @returns { fg, bg, mods }
 */
export function parseCellStyle(
  styles: Array<{ type: string; code: string; endCode: string }>,
): {
  fg: number;
  bg: number;
  mods: number;
} {
  let fg = COLOR_DEFAULT;
  let bg = COLOR_DEFAULT;
  let mods = 0;

  // 将所有 ANSI code 字符串转换为 SGR 参数数组
  const allParams: number[] = [];
  for (const style of styles) {
    if (style.type === "ansi") {
      allParams.push(...extractSgrParams(style.code));
    }
  }

  // 解析 SGR 参数
  for (let i = 0; i < allParams.length; i++) {
    const code = allParams[i];

    // Reset
    if (code === 0) {
      fg = COLOR_DEFAULT;
      bg = COLOR_DEFAULT;
      mods = 0;
      continue;
    }

    // Modifiers: 1-9
    if (code === 1) mods |= MOD_BOLD;
    else if (code === 2) mods |= MOD_DIM;
    else if (code === 3) mods |= MOD_ITALIC;
    else if (code === 4) mods |= MOD_UNDERLINE;
    else if (code === 5) mods |= MOD_BLINK;
    else if (code === 7) mods |= MOD_REVERSE;
    else if (code === 8) mods |= MOD_HIDDEN;
    else if (code === 9) mods |= MOD_STRIKETHROUGH;
    // Reset modifiers: 22-29
    else if (code === 22) mods &= ~(MOD_BOLD | MOD_DIM);
    else if (code === 23) mods &= ~MOD_ITALIC;
    else if (code === 24) mods &= ~MOD_UNDERLINE;
    else if (code === 25) mods &= ~MOD_BLINK;
    else if (code === 27) mods &= ~MOD_REVERSE;
    else if (code === 28) mods &= ~MOD_HIDDEN;
    else if (code === 29) mods &= ~MOD_STRIKETHROUGH;
    // 前景色: 30-37 (基本), 90-97 (亮)
    else if (code >= 30 && code <= 37) {
      fg = BASIC_COLORS[code - 30];
    } else if (code >= 90 && code <= 97) {
      fg = BRIGHT_COLORS[code - 90];
    }
    // 背景色: 40-47 (基本), 100-107 (亮)
    else if (code >= 40 && code <= 47) {
      bg = BASIC_COLORS[code - 40];
    } else if (code >= 100 && code <= 107) {
      bg = BRIGHT_COLORS[code - 100];
    }
    // 前景色默认: 39
    else if (code === 39) {
      fg = COLOR_DEFAULT;
    }
    // 背景色默认: 49
    else if (code === 49) {
      bg = COLOR_DEFAULT;
    }
    // 256 色 / 24 位色: 38;5;N / 38;2;R;G;B
    else if (code === 38 && i + 1 < allParams.length) {
      const mode = allParams[i + 1];
      if (mode === 5 && i + 2 < allParams.length) {
        // 256 色
        fg = get256Color(allParams[i + 2]);
        i += 2;
      } else if (mode === 2 && i + 4 < allParams.length) {
        // 24 位色
        const r = allParams[i + 2];
        const g = allParams[i + 3];
        const b = allParams[i + 4];
        fg = (r << 16) | (g << 8) | b;
        i += 4;
      }
    }
    // 背景 256 色 / 24 位色: 48;5;N / 48;2;R;G;B
    else if (code === 48 && i + 1 < allParams.length) {
      const mode = allParams[i + 1];
      if (mode === 5 && i + 2 < allParams.length) {
        bg = get256Color(allParams[i + 2]);
        i += 2;
      } else if (mode === 2 && i + 4 < allParams.length) {
        const r = allParams[i + 2];
        const g = allParams[i + 3];
        const b = allParams[i + 4];
        bg = (r << 16) | (g << 8) | b;
        i += 4;
      }
    }
  }

  return { fg, bg, mods };
}

/**
 * 将 StyledChar[] 写入 ScreenBuffer
 * @param buffer 目标 buffer
 * @param x 起始 x 坐标
 * @param y 起始 y 坐标
 * @param chars StyledChar 数组
 * @param clipRect 可选裁剪区域 { x1, x2, y1, y2 }
 */
export function writeStyledChars(
  buffer: ScreenBuffer,
  x: number,
  y: number,
  chars: StyledChar[],
  clipRect?: { x1?: number; x2?: number; y1?: number; y2?: number },
): void {
  // 垂直裁剪
  if (clipRect?.y1 !== undefined && y < clipRect.y1) return;
  if (clipRect?.y2 !== undefined && y > clipRect.y2) return;

  let offsetX = x;

  for (const char of chars) {
    // 水平裁剪
    if (clipRect?.x1 !== undefined && offsetX < clipRect.x1) {
      offsetX += Math.max(1, stringWidth(char.value));
      continue;
    }
    if (clipRect?.x2 !== undefined && offsetX > clipRect.x2) {
      break;
    }

    const { fg, bg, mods } = parseCellStyle(char.styles);
    const charWidth = Math.max(1, stringWidth(char.value));

    buffer.setCell(offsetX, y, char.value, fg, bg, mods, charWidth);
    offsetX += charWidth;
  }
}

/**
 * 将带 ANSI 的文本字符串写入 ScreenBuffer
 * @param buffer 目标 buffer
 * @param x 起始 x 坐标
 * @param y 起始 y 坐标
 * @param text 带 ANSI 的文本
 * @param clipRect 可选裁剪区域
 */
export function writeAnsiText(
  buffer: ScreenBuffer,
  x: number,
  y: number,
  text: string,
  clipRect?: { x1?: number; x2?: number; y1?: number; y2?: number },
): void {
  const tokens = tokenize(text);
  const chars = styledCharsFromTokens(tokens);
  writeStyledChars(buffer, x, y, chars, clipRect);
}
