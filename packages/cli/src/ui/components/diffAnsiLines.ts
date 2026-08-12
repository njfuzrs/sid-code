/**
 * DF3 — diff 的 ANSI 行生产者（性能重写路径）
 *
 * 把折叠后的 diff 计划渲染成「每行一条预着色 ANSI 字符串」,供 <RawAnsi> 走单 Yoga leaf
 * 直出 output.write(),绕过「每行一棵 React <Box>/<Text> 子树 → Yoga flex → squash →
 * 重序列化」的回环。长 diff(几百行)时这个回环是渲染主成本。
 *
 * 视觉与 React 路径保持一致:
 * - 右对齐行号槽(宽度 = 最大行号位数 + 1)
 * - 行首 +/- 符号加粗(色盲友好,不只靠背景色)
 * - add/del 整行底色;词级强调段额外加粗 + emphasis 底色
 * - context 行无底色
 * - 折叠占位行「… N 行未变更上下文已折叠」
 *
 * 纯函数(不依赖 React),便于单测。颜色经引擎 colorize/applyTextStyles 生成 ANSI。
 */

import { diffWordsWithSpace } from "diff";
import { applyColor, colorize, applyTextStyles } from "@sid-code/tui-renderer/colorize.ts";
import { stringWidth } from "@sid-code/tui-renderer/stringWidth.ts";
import { ELLIPSIS } from "../constants/collapse.ts";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
import type { DiffLine, DiffRenderPlanItem } from "./DiffRenderer.js";

/** 生产 ANSI 行所需的颜色(从 semanticTheme 取实际色值,避免本模块依赖主题单例) */
export interface DiffAnsiColors {
  /** 行号/次要文本色 */
  secondary: Color;
  /** 新增前景(+/词级) */
  addFg: Color;
  /** 删除前景(-/词级) */
  delFg: Color;
  /** 新增整行底色 */
  addBg: Color;
  /** 删除整行底色 */
  delBg: Color;
  /** 新增词级强调底色 */
  addEmphasisBg: Color;
  /** 删除词级强调底色 */
  delEmphasisBg: Color;
}

/** 右对齐补足到指定宽度(按显示宽度计) */
function padStart(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  return " ".repeat(width - w) + s;
}

/**
 * 渲染一行的「内容段」(不含行号槽),返回 { ansi, plainWidth }。
 * which 为 add/del 时做词级强调;context / 无对侧时整段同色。
 */
function renderContentSegment(
  displayContent: string,
  pairContent: string | undefined,
  which: "del" | "add" | "context",
  colors: DiffAnsiColors,
): { ansi: string; plain: string } {
  if (which === "context") {
    return { ansi: displayContent, plain: displayContent };
  }
  const fg = which === "del" ? colors.delFg : colors.addFg;
  const emphBg = which === "del" ? colors.delEmphasisBg : colors.addEmphasisBg;

  if (pairContent === undefined) {
    // 无对侧配对:整行同前景色(不强调)
    return { ansi: applyColor(displayContent, fg), plain: displayContent };
  }

  // 词级 diff:del 行强调被删词,add 行强调新增词
  const oldContent = which === "del" ? displayContent : pairContent;
  const newContent = which === "del" ? pairContent : displayContent;
  const parts = diffWordsWithSpace(oldContent, newContent);
  let ansi = "";
  let plain = "";
  for (const part of parts) {
    if (which === "del" && part.added) continue;
    if (which === "add" && part.removed) continue;
    const changed = which === "del" ? part.removed : part.added;
    if (changed) {
      // 加粗 + emphasis 底色 + 前景色
      const colored = colorize(applyColor(part.value, fg), emphBg, "background");
      ansi += applyTextStyles(colored, { bold: true });
    } else {
      ansi += applyColor(part.value, fg);
    }
    plain += part.value;
  }
  return { ansi, plain };
}

export interface BuildDiffAnsiLinesOptions {
  /** 折叠后的渲染计划(planDiffWithContextCollapse 产出) */
  plan: DiffRenderPlanItem[];
  /** 原始可显示行(供查 oldLine/newLine 行号) */
  displayableLines: DiffLine[];
  /** 词级配对:index → 对侧裁剪后内容 */
  pairMap: Map<number, string>;
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
  const { plan, displayableLines, pairMap, baseIndentation, gutterWidth, terminalWidth, colors } =
    opts;
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
    const seg = renderContentSegment(displayContent, pairMap.get(index), which, colors);

    // 行号槽:右对齐数字 + 1 空格,次要色
    const gutter = applyColor(padStart(gutterNumStr, gutterWidth) + " ", colors.secondary);

    // 前缀符号:add/del 加粗着色;context 普通
    const prefixAnsi =
      which === "context"
        ? prefix + " "
        : applyTextStyles(applyColor(prefix, which === "add" ? colors.addFg : colors.delFg), {
            bold: true,
          }) + " ";

    // 计算内容区可见宽度,用空格补足使底色铺满到 terminalWidth
    const prefixPlainW = 2; // 符号 + 空格
    const contentPlainW = stringWidth(seg.plain);
    const usedW = gutterCols + prefixPlainW + contentPlainW;
    const fillW = Math.max(0, terminalWidth - usedW);

    // 整行(含行号槽)拼装;add/del 行对整体上底色,与 React 路径(gutter Box + 内容 Text 同色底)一致。
    // chalk 背景包裹会在内层词级强调底色的 close 序列处自动重开外层底色,嵌套安全。
    let line = gutter + prefixAnsi + seg.ansi + " ".repeat(fillW);
    if (rowBg) {
      line = colorize(line, rowBg, "background");
    }

    out.push(line);
  }

  return out;
}
