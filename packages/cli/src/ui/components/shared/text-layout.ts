/**
 * 列表/表格行的文本布局工具（纯函数，CJK 安全）。
 *
 * 为什么要有这一层：多个面板把「名称 / 标签 / 描述」直接平铺成 flex row 的兄弟 Text，
 * 外部数据（skill 描述、MCP 错误、hook 命令、配置值）一长或一带换行，yoga 就压缩前面的
 * Text，名称被折成两行、每行描述起点不同——即「没对齐、没分栏」。
 * 统一做法：先按**显示列宽**算好每格宽度、压成单行、截断补齐，渲染层只负责上色。
 *
 * 注意 `.slice(0, n)` 按 UTF-16 码元截，中文/emoji 下会超宽，这里一律按 stringWidth 截。
 */
import { stringWidth } from "../../render-port/text.ts";

/** 按显示列宽截断，超出时预留 1 列给省略号 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  let w = 0;
  let out = "";
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth - 1) break;
    w += cw;
    out += ch;
  }
  return out + "…";
}

/** 把换行与连续空白压成单个空格：外部描述常带换行，混进来会破坏「一项一行」 */
export function oneLine(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** 按显示列宽右侧补空格 */
export function padEndToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)));
}

/** 定宽单元格：压成单行 → 截断 → 补齐，结果显示宽度恒等于 width */
export function fitCell(text: string | undefined | null, width: number): string {
  return padEndToWidth(truncateToWidth(oneLine(text), width), width);
}

/** 单行截断（不补齐），用于行尾的可变长列 */
export function clipLine(text: string | undefined | null, width: number): string {
  return truncateToWidth(oneLine(text), width);
}

/**
 * 列宽 = 所有值里最宽的那个，但不超过 cap，也不小于 min。
 * 无上限时一条超长值会把所有行推宽然后整体折行（MemoryDialog 实测形态）。
 */
export function columnWidth(values: string[], cap: number, min = 0): number {
  const widest = Math.max(0, ...values.map((v) => stringWidth(oneLine(v))));
  return Math.max(min, Math.min(widest, Math.max(min, cap)));
}
