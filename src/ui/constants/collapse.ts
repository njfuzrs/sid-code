/**
 * 折叠摘要文案统一收口（对标 cc 的 `… +N more`）。
 *
 * 此前各处自编：MaxSizedBox 用 ASCII `... N 行已隐藏 ...`、SlicingMaxSizedBox 用
 * `... N 行已隐藏 ...`（且无展开提示）、DiffRenderer 用 `⋯ N 行...已折叠`、
 * ThinkingMessage 用 `✻ ... ctrl+t 展开`、ToolGroup 用 `Ctrl+O 展开完整输出`。
 * 省略号有 `...` / `⋯` / `…` 三种，展开提示有的缺、有的大小写不一。
 *
 * 统一规则：
 * - 省略号一律用 Unicode `…`（U+2026），不用 ASCII 三连点、不用 `⋯`。
 * - 摘要格式：`… N 行已折叠`（unit 可换为「字符」等）。
 * - 展开提示统一小写 `ctrl+o`/`ctrl+t`，用 ` · ` 与摘要分隔。
 */

/** 统一省略号字形（U+2026），禁用 ASCII `...` 与 `⋯` */
export const ELLIPSIS = "…";

/** 展开快捷键标识：工具/通用走 ctrl+o，思考块走 ctrl+t */
export type ExpandHint = "ctrl+o" | "ctrl+t" | null;

export interface CollapsedSummaryOptions {
  /** 计量单位，默认「行」（也可「字符」等） */
  unit?: string;
  /** 展开快捷键提示；传 null 表示不显示展开提示 */
  hint?: ExpandHint;
}

/**
 * 生成统一格式的折叠摘要文案。
 *
 * @example
 *   formatCollapsedSummary(12)                          // "… 12 行已折叠"
 *   formatCollapsedSummary(12, { hint: "ctrl+o" })      // "… 12 行已折叠 · ctrl+o 展开"
 *   formatCollapsedSummary(800, { unit: "字符", hint: "ctrl+t" }) // "… 800 字符已折叠 · ctrl+t 展开"
 */
export function formatCollapsedSummary(
  count: number,
  options: CollapsedSummaryOptions = {},
): string {
  const { unit = "行", hint = null } = options;
  const base = `${ELLIPSIS} ${count} ${unit}已折叠`;
  return hint ? `${base} · ${hint} 展开` : base;
}
