/**
 * 命令输出面板的纯函数部分：换行、视口高度、滚动夹取。
 *
 * 与组件拆开是为了单测能直接锁口径（视口不顶出屏幕、滚动不越界），
 * 不必渲染整棵 Ink 树。
 */

import wrapAnsi from "wrap-ansi";

/** 面板外框 + 标题 + 底部提示占用的行数：上下边框 2 + 标题 1 + 标题下留白 1 + 底部提示 1 + 提示上留白 1 */
export const PANEL_CHROME_ROWS = 6;

/** 面板之外要给输入区之上的其它块（状态行、错误面板等）留的行数，避免整屏被面板占满 */
export const PANEL_SCREEN_RESERVE_ROWS = 4;

/** 视口至少这么多行：极矮终端下仍然能看到内容，而不是只剩边框 */
export const PANEL_MIN_VIEWPORT_ROWS = 3;

/** 面板占用的列数：只有 paddingX=1 左右各 1（无左右竖线，见 CommandOutputDialog 头注释） */
export const PANEL_HORIZONTAL_CHROME = 2;

/**
 * 按终端宽度把命令输出折成视觉行（宽度感知：CJK 占 2 列）。
 *
 * 命令输出里可能带 ANSI 颜色（self-check 那几行），wrap-ansi 在折行时保留样式。
 * 制表符先展开成 2 空格：终端对 \t 的列宽不定，按 1 列算会让右边框错位。
 */
export function wrapPanelContent(content: string, width: number): string[] {
  const cols = Math.max(width, 10);
  const normalized = content.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd();
  if (!normalized) return [];
  return wrapAnsi(normalized, cols, { hard: true, trim: false, wordWrap: true }).split("\n");
}

/** 内容区可见行数：终端高度减去面板外框与预留，夹在 [PANEL_MIN_VIEWPORT_ROWS, 内容行数] */
export function panelViewportRows(terminalRows: number, contentRows: number): number {
  const available = terminalRows - PANEL_CHROME_ROWS - PANEL_SCREEN_RESERVE_ROWS;
  const viewport = Math.max(available, PANEL_MIN_VIEWPORT_ROWS);
  return Math.max(Math.min(viewport, contentRows), 0);
}

/** 滚动偏移的上限（内容不足一屏时为 0） */
export function maxPanelOffset(contentRows: number, viewportRows: number): number {
  return Math.max(contentRows - viewportRows, 0);
}

/** 把滚动偏移夹进 [0, max] */
export function clampPanelOffset(
  offset: number,
  contentRows: number,
  viewportRows: number,
): number {
  return Math.min(Math.max(offset, 0), maxPanelOffset(contentRows, viewportRows));
}

/** 滚动位置提示：`12–30 / 85 行`；内容一屏放得下时返回 null（不显示） */
export function panelScrollLabel(
  offset: number,
  viewportRows: number,
  contentRows: number,
): string | null {
  if (contentRows <= viewportRows) return null;
  const first = offset + 1;
  const last = Math.min(offset + viewportRows, contentRows);
  return `${first}–${last} / ${contentRows} 行`;
}
