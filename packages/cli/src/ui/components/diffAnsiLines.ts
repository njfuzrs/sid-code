/**
 * DF3 — diff 的 ANSI 行生产者（性能重写路径）
 *
 * 把折叠后的 diff 计划渲染成「每行一条预着色 ANSI 字符串」,供 <RawAnsi> 走单 Yoga leaf
 * 直出 output.write(),绕过「每行一棵 React <Box>/<Text> 子树 → Yoga flex → squash →
 * 重序列化」的回环。长 diff(几百行)时这个回环是渲染主成本。
 *
 * 视觉与 React 路径保持一致:
 * - 右对齐行号槽(宽度 = 最大行号位数 + 1)
 * - 行首 +/- 符号着色(颜色 + 字形两个通道,不靠加粗)
 * - add/del 整行单一底色 + 整行单一状态前景色;context 行无底色
 * - 折叠占位行「… N 行未变更上下文已折叠」
 *
 * **一行只有一种底色、一种文字色**:既不加粗,也不做词级强调(曾经有 emphasis 底色,
 * 2026-11-17 去掉——它在中文行里按字切分,同一行出现两块深浅不同的底色,
 * 观感像「背景叠了两层」)。判据与论证见
 * `.agents/notes/implemented/bug-fix/2026-11-17-diff-single-background.md`。
 * 纯函数(不依赖 React),便于单测。颜色经引擎 colorize/applyTextStyles 生成 ANSI。
 */

import { applyColor, colorize, applyTextStyles } from "../render-port/text.ts";
import { stringWidth } from "../render-port/text.ts";
import { ELLIPSIS } from "../constants/collapse.ts";
import type { Color } from "../render-port/types.ts";
import type { DiffLine, DiffRenderPlanItem } from "./DiffRenderer.js";

/** 生产 ANSI 行所需的颜色(从 semanticTheme 取实际色值,避免本模块依赖主题单例) */
export interface DiffAnsiColors {
  /** 行号/次要文本色 */
  secondary: Color;
  /** 新增前景(整行文字 + `+` 符号) */
  addFg: Color;
  /** 删除前景(整行文字 + `-` 符号) */
  delFg: Color;
  /** 新增整行底色(全行唯一底色) */
  addBg: Color;
  /** 删除整行底色(全行唯一底色) */
  delBg: Color;
}

/** 右对齐补足到指定宽度(按显示宽度计) */
function padStart(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  return " ".repeat(width - w) + s;
}

/**
 * 渲染一行的「内容段」(不含行号槽),返回 { ansi, plain }。
 *
 * add/del 行整段用同一状态前景色;context 行原样(无底色、无附加前景)。
 * **不做词级强调**:它曾经用 emphasis 底色,而 `diffWordsWithSpace` 对 CJK 没有词边界、
 * 退化成按字切分,于是一行中文里散落个别碎片段被换成更深的底色——观感就是
 * 「同一块 diff 有的字深、有的字浅,像背景叠了两层」。
 */
function renderContentSegment(
  displayContent: string,
  which: "del" | "add" | "context",
  colors: DiffAnsiColors,
): { ansi: string; plain: string } {
  if (which === "context") {
    return { ansi: displayContent, plain: displayContent };
  }
  const fg = which === "del" ? colors.delFg : colors.addFg;
  return { ansi: applyColor(displayContent, fg), plain: displayContent };
}

export interface BuildDiffAnsiLinesOptions {
  /** 折叠后的渲染计划(planDiffWithContextCollapse 产出) */
  plan: DiffRenderPlanItem[];
  /** 原始可显示行(供查 oldLine/newLine 行号) */
  displayableLines: DiffLine[];
  /** 公共前导缩进裁剪量 */
  baseIndentation: number;
  /** 行号槽内容宽度(最大行号位数) */
  gutterWidth: number;
  /** 终端列宽(整行底色铺满到此) */
  terminalWidth: number;
  colors: DiffAnsiColors;
}

/**
 * 把折叠计划渲染为 ANSI 字符串行数组。每个元素恰好一终端行,已含全部 ANSI 转义。
 */
export function buildDiffAnsiLines(opts: BuildDiffAnsiLinesOptions): string[] {
  const { plan, displayableLines, baseIndentation, gutterWidth, terminalWidth, colors } = opts;
  // 行号槽 = gutterWidth + 1 个右侧空格(与 React 路径 width={gutterWidth+1}+paddingRight 对齐)
  const gutterCols = gutterWidth + 1;
  const out: string[] = [];

  for (const item of plan) {
    if (item.kind === "collapsed") {
      const text = `${ELLIPSIS} ${item.hiddenCount} 行未变更上下文已折叠`;
      // 折叠提示行:行号槽留白 + dim 次要色
      const indent = " ".repeat(gutterCols + 1);
      out.push(indent + applyTextStyles(applyColor(text, colors.secondary), { dim: true }));
      continue;
    }

    const index = item.origIndex!;
    const srcLine = displayableLines[index];
    let gutterNumStr = "";
    let prefix = " ";
    let rowBg: string | undefined;
    let which: "del" | "add" | "context";

    switch (srcLine.type) {
      case "add":
        gutterNumStr = (srcLine.newLine ?? "").toString();
        prefix = "+";
        rowBg = colors.addBg;
        which = "add";
        break;
      case "del":
        gutterNumStr = (srcLine.oldLine ?? "").toString();
        prefix = "-";
        rowBg = colors.delBg;
        which = "del";
        break;
      case "context":
      default:
        gutterNumStr = (srcLine.newLine ?? "").toString();
        prefix = " ";
        rowBg = undefined;
        which = "context";
        break;
    }

    const displayContent = srcLine.content.substring(baseIndentation);
    const seg = renderContentSegment(displayContent, which, colors);

    // 行号槽:右对齐数字 + 1 空格,次要色
    const gutter = applyColor(padStart(gutterNumStr, gutterWidth) + " ", colors.secondary);

    // 前缀符号:add/del 着色;context 普通(不加粗,字重全区域统一)
    const prefixAnsi =
      which === "context"
        ? prefix + " "
        : applyColor(prefix, which === "add" ? colors.addFg : colors.delFg) + " ";

    // 计算内容区可见宽度,用空格补足使底色铺满到 terminalWidth
    const prefixPlainW = 2; // 符号 + 空格
    const contentPlainW = stringWidth(seg.plain);
    const usedW = gutterCols + prefixPlainW + contentPlainW;
    const fillW = Math.max(0, terminalWidth - usedW);

    // 整行(含行号槽)拼装;add/del 行对整体上底色,与 React 路径(gutter Box + 内容 Text 同色底)一致。
    // 全行只有这一层底色:内容段内部不再有第二层背景(词级强调已于 2026-11-17 去掉)。
    let line = gutter + prefixAnsi + seg.ansi + " ".repeat(fillW);
    if (rowBg) {
      line = colorize(line, rowBg, "background");
    }

    out.push(line);
  }

  return out;
}
