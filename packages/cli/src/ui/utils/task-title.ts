/**
 * 任务名生成（终端标题用）
 *
 * 两级策略,对标 claude-code：
 * 1. deriveTaskTitle —— 纯本地启发式,从首条用户消息即时截取一个简短任务名。
 *    零 LLM 成本、零延迟,提交瞬间就能让多窗口区分开。
 * 2. 后台再用小模型(Haiku)生成更凝练的标题覆盖(在 app.ts 接线,非本模块职责)。
 *
 * 设计要点：
 * - 用 stringWidth 而非 .length 计算显示宽度——CJK / emoji 占 2 列,
 *   .length 会让中文标题被截到一半或留白漂移（项目 L2.3 铁律）。
 * - 标题写进 OSC 0 终端标题栏,空间有限,默认裁到约 24 显示列。
 * - 去掉 @文件引用 / 前导 slash 命令 / 多余空白,保留语义主体。
 */

import { stringWidth } from "@sid-code/tui-renderer/stringWidth.ts";

/** 标题最大显示宽度（列）。OSC 标题栏空间有限,过长会被终端自行截断。 */
const MAX_TITLE_WIDTH = 24;

/** 省略号(单字符,占 1 列)。 */
const ELLIPSIS = "…";

/**
 * 按显示宽度(列)截断字符串,超出时追加省略号。
 * 用 stringWidth 累加每个字符的列宽,而非按码点数截断。
 */
function truncateByWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  // 预留 1 列给省略号
  const budget = Math.max(1, maxWidth - 1);
  let acc = "";
  let width = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w > budget) break;
    acc += ch;
    width += w;
  }
  return acc + ELLIPSIS;
}

/**
 * 从首条用户消息派生一个简短任务名,供终端标题即时显示。
 *
 * @param firstMessage 用户首条输入原文
 * @returns 简短任务名;输入为空/纯命令时返回 null（调用方回退到项目名）
 */
export function deriveTaskTitle(firstMessage: string): string | null {
  let text = (firstMessage ?? "").trim();
  if (!text) return null;

  // 纯 slash 命令(如 "/model")不作为任务名——回退项目名更合理。
  if (text.startsWith("/")) return null;

  // 去掉 @文件引用 token(展开前的 @path),它们是上下文不是任务描述。
  text = text.replace(/(^|\s)@[^\s]+/g, " ");

  // 折叠所有空白(含换行)为单空格,去首尾。
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;

  return truncateByWidth(text, MAX_TITLE_WIDTH);
}
