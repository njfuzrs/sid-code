/**
 * Cell 内存布局常量
 *
 * 每个 cell 占 4 个 Uint32（16 字节）：
 * - SLOT_CHAR: Unicode code point 或溢出索引
 * - SLOT_FG: 前景色 0x00RRGGBB（0 = 默认色）
 * - SLOT_BG: 背景色 0x00RRGGBB（0 = 默认色）
 * - SLOT_FLAGS: modifier flags(低8位) | width(bits 16-17) | overflow(bit 24)
 */

/** Cell 在 buffer 中的步长（4 个 uint32） */
export const CELL_STRIDE = 4;

/** Slot 索引 */
export const SLOT_CHAR = 0;
export const SLOT_FG = 1;
export const SLOT_BG = 2;
export const SLOT_FLAGS = 3;

/** Modifier flags（与 ANSI SGR 对应） */
export const MOD_BOLD = 1 << 0;
export const MOD_DIM = 1 << 1;
export const MOD_ITALIC = 1 << 2;
export const MOD_UNDERLINE = 1 << 3;
export const MOD_BLINK = 1 << 4;
export const MOD_REVERSE = 1 << 5;
export const MOD_HIDDEN = 1 << 6;
export const MOD_STRIKETHROUGH = 1 << 7;

/** 特殊标志 */
export const FLAG_OVERFLOW = 1 << 24; // 字符存储在 overflow map 中

/** 颜色常量 */
export const COLOR_DEFAULT = 0; // 终端默认色（输出 SGR 39/49）

/** ANSI 序列常量 */
export const BSU = "\x1b[?2026h"; // DEC 2026 同步开始
export const ESU = "\x1b[?2026l"; // DEC 2026 同步结束
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const RESET_STYLE = "\x1b[0m";

/** 光标移动 */
export const CUU = (n: number) => (n > 0 ? `\x1b[${n}A` : ""); // 上移
export const CUD = (n: number) => (n > 0 ? `\x1b[${n}B` : ""); // 下移
export const CUF = (n: number) => (n > 0 ? `\x1b[${n}C` : ""); // 右移
export const CUP = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`; // 绝对定位
