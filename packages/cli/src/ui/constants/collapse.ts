/**
 * 折叠摘要文案统一收口（对标 cc 的 `… +N more`）。
 *
 * 此前各处自编：MaxSizedBox 用 ASCII `... N 行已隐藏 ...`、SlicingMaxSizedBox 用
 * `... N 行已隐藏 ...`（且无展开提示）、DiffRenderer 用 `⋯ N 行...已折叠`、
 * ThinkingMessage 用 `✻ ... ctrl+o 展开`、ToolGroup 用 `Ctrl+O 展开完整输出`。
 * 省略号有 `...` / `⋯` / `…` 三种，展开提示有的缺、有的大小写不一。
 *
 * 统一规则：
 * - 省略号一律用 Unicode `…`（U+2026），不用 ASCII 三连点、不用 `⋯`。
 * - 摘要格式：`… N 行已折叠`（unit 可换为「字符」等）。
 * - 展开提示统一小写 `ctrl+o`（对标 cc 单键管所有折叠区），用 ` · ` 与摘要分隔。
 */

/** 统一省略号字形（U+2026），禁用 ASCII `...` 与 `⋯` */
export const ELLIPSIS = "…";

/** 展开快捷键标识：工具/思考/通用折叠区统一走 ctrl+o（对标 cc 单键展开） */
export type ExpandHint = "ctrl+o" | null;

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
 *   formatCollapsedSummary(800, { unit: "字符", hint: "ctrl+o" }) // "… 800 字符已折叠 · ctrl+o 展开"
 */
export function formatCollapsedSummary(
  count: number,
  options: CollapsedSummaryOptions = {},
): string {
  const { unit = "行", hint = null } = options;
  const base = `${ELLIPSIS} ${count} ${unit}已折叠`;
  return hint ? `${base} · ${hint} 展开` : base;
}

/** Shell 命令截断阈值（对标 cc BashTool/UI.tsx: MAX_COMMAND_DISPLAY_LINES=2, MAX_COMMAND_DISPLAY_CHARS=160） */
export const CMD_MAX_LINES = 2;
export const CMD_MAX_CHARS = 160;

/** Shell 命令截断结果。text 为截断后的命令正文（不含 `$ ` / `! ` 前缀，由调用方拼接）。 */
export interface TruncatedShellCommand {
  /** 截断后的命令正文（已 trim，截断时尾部带 ELLIPSIS）。 */
  text: string;
  /** 是否发生了截断。 */
  truncated: boolean;
  /** 折叠摘要文案（未截断时为空串）。 */
  summary: string;
}

/**
 * 对 shell 命令做两级截断（先按行、再按字符），对标 cc BashTool/UI.tsx。
 *
 * 纯函数，不含前缀：调用方负责拼 `$ ` / `! `。`expanded=true` 时原样返回完整命令。
 * 统一换行符为 \n（兼容 Windows \r\n），避免字符计数偏大、前缀与命令不对齐。
 */
export function truncateShellCommand(command: string, expanded: boolean): TruncatedShellCommand {
  const normalized = command.replace(/\r\n/g, "\n");

  if (expanded) {
    return { text: normalized, truncated: false, summary: "" };
  }

  const lines = normalized.split("\n");
  const needsLineTruncation = lines.length > CMD_MAX_LINES;
  const needsCharTruncation = normalized.length > CMD_MAX_CHARS;

  if (!needsLineTruncation && !needsCharTruncation) {
    return { text: normalized, truncated: false, summary: "" };
  }

  let truncated = normalized;
  let unit = "行";
  let count = 0;
  let hasLineCut = false;

  // 先按行截断
  if (needsLineTruncation) {
    count = lines.length - CMD_MAX_LINES;
    truncated = lines.slice(0, CMD_MAX_LINES).join("\n");
    hasLineCut = true;
  }

  // 再按字符截断（如先行截后仍超字符，说明保留的行中某行本身太长）
  if (truncated.length > CMD_MAX_CHARS) {
    const charCut = truncated.length - CMD_MAX_CHARS;
    if (hasLineCut) {
      // 双重截断：先去了 N 行，余下行又截了 M 字符，按维度分报告
      count += charCut;
      unit = "行/字符";
    } else {
      count = charCut;
      unit = "字符";
    }
    truncated = truncated.slice(0, CMD_MAX_CHARS);
  }

  return {
    text: `${truncated.trim()}${ELLIPSIS}`,
    truncated: true,
    summary: formatCollapsedSummary(count, { unit, hint: "ctrl+o" }),
  };
}
