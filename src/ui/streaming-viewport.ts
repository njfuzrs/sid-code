/**
 * 主屏 Static 模式流式视口裁剪（ADR-040 防闪烁）
 *
 * 背景：ink 主屏渲染路径在「动态区(非 Static)渲染高度 >= 终端行数」时，
 * log-update 的 diff 会命中 fullResetSequence_CAUSES_FLICKER 路径
 * （见 src/ink/log-update.ts:214/242/266，scrollback 行变化时整屏重打）。
 * 流式回复一旦超过一屏，30fps 下即触发全屏闪烁/疯狂刷屏。
 *
 * 注意：本项目渲染底座已是 vendor 进 src/ink 的 claude-code 同款 ink fork
 * （做行级 diff、blit），但上述「高度 >= 视口 → 整屏重打」的退化路径在 fork 中
 * 依然存在。因此「动态区高度必须始终 < 终端行数」这一不变量仍需成立，
 * 正解仍是：把会随流式增长的内容（流式正文 / 思考）按可用视口高度做尾部截断 ——
 * 只渲染最新的若干行（正文用块级 tailToFitByBlocks，思考用物理行 tailToFit）。
 *
 * 流式完成后整条消息并入 historyItems → 进 <Static> 打印进终端 scrollback（完整内容、可原生上滚回看）。
 * 所以「流式中看尾部、完成后看全文」与 claude-code 的 log-update 小动态区模型一致。
 */

import stringWidth from "string-width";
import { cachedLexer } from "./markdown.ts";

/**
 * 计算一段文本按指定宽度软换行后的渲染行数。
 * 空逻辑行算 1 行（终端里也占 1 行）。
 */
export function wrappedHeight(text: string, width: number): number {
  const w = Math.max(1, width);
  let total = 0;
  for (const line of text.split("\n")) {
    const lw = stringWidth(line);
    total += Math.max(1, Math.ceil(lw / w));
  }
  return total;
}

/**
 * 返回 text 的「尾部」子串，使其按 width 软换行后的渲染高度 <= maxLines。
 *
 * - maxLines <= 0 → 返回空串。
 * - 从最后一行往上累加，直到再加一行就超预算为止，保留能放下的尾部逻辑行。
 * - 极端情况：单条逻辑行本身就超过 maxLines（超长无换行段落）→ 退化为对最后一行
 *   做字符级尾部硬截断（取末尾约 maxLines*width 个显示宽度的内容），保证仍有内容可见
 *   且不超高。
 *
 * 不保证 markdown 结构完整（尾部可能从代码块中间起头）——流式中的瞬时视图，
 * 完成后会以完整内容进 Static，可接受。
 */
export function tailToFit(text: string, width: number, maxLines: number): string {
  if (maxLines <= 0 || !text) return "";
  const w = Math.max(1, width);
  const lines = text.split("\n");

  let used = 0;
  let startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = Math.max(1, Math.ceil(stringWidth(lines[i]) / w));
    if (used + h > maxLines) break;
    used += h;
    startIdx = i;
  }

  // 至少有一整行能放下：返回尾部逻辑行
  if (startIdx < lines.length) {
    return lines.slice(startIdx).join("\n");
  }

  // 一行都放不下（最后一行超长）：对最后一行做字符级尾部硬截断
  const last = lines[lines.length - 1] ?? "";
  const budget = maxLines * w;
  // 从尾部累计显示宽度，截取能放下的后缀
  let acc = 0;
  let cut = last.length;
  for (let i = last.length - 1; i >= 0; i--) {
    acc += stringWidth(last[i]);
    if (acc > budget) break;
    cut = i;
  }
  return last.slice(cut);
}

/** 底部固定 chrome（Composer + Footer + padding + slack）的基础预留行数。
 *  含动态区 gap={1} 在「流式内容 ↔ 瞬态块 ↔ 输入框」之间引入的留白行，
 *  偏保守多留 2 行，确保动态区总高仍 < 终端行数（宁可多扣、少给流式几行）。 */
const BASE_CHROME_LINES = 10;

/**
 * 估算当前动态区底部 chrome 占用的行数，用于从终端总高度中扣除，
 * 得到留给流式内容的可用高度。
 *
 * 估算偏保守（宁可多扣、少给流式几行），确保动态区总高 < 终端行数。
 */
export function estimateChromeLines(opts: {
  todoCount: number;
  taskCount: number;
  hasStatusMessage: boolean;
}): number {
  let reserved = BASE_CHROME_LINES;
  if (opts.todoCount > 0) reserved += Math.min(opts.todoCount, 8) + 1;
  if (opts.taskCount > 0) reserved += Math.min(opts.taskCount, 6) + 1;
  if (opts.hasStatusMessage) reserved += 1;
  return reserved;
}

/**
 * 给定终端总行数与 chrome 预留，返回流式正文 / 思考各自的可用行预算。
 *
 * 对标 claude-code：思考不是主角，正文才是；**思考在主流中恒为一行**。
 * cc 的 AssistantThinkingMessage 在常规 REPL 视图永远只渲染一行
 * `∴ Thinking · ctrl+o to expand`，实时「正在思考」反馈交给 spinner 的计时微光，
 * 思考全文仅在 transcript/verbose 模式展开。这样思考块高度恒定 → 全程零跳动。
 *
 * 故本函数对思考一律只给 1 行预算（折叠占位信号），不再分纯思考 / 思考+正文两态：
 * - 思考存在：thinkingLines=1（单行摘要，实时计时原地更新，高度稳定）；
 *   正文若也存在则独占其余视口，否则正文预算为 0（纯思考阶段下方暂无正文）。
 * - 仅正文存在：正文独占全部预算。
 *
 * 关键：思考全程 thinkingLines=1，彻底消除「纯思考逐字展开 → 正文开始时塌缩成
 * 一行」的高度突变（页面上跳 N-1 行的跳动根因）。
 */
export function computeStreamBudgets(
  rows: number,
  chromeLines: number,
  hasThinking: boolean,
  hasText: boolean,
): { thinkingLines: number; textLines: number } {
  const MIN_STREAM_LINES = 3;
  const avail = Math.max(MIN_STREAM_LINES, rows - chromeLines);

  if (hasThinking) {
    // 思考恒折叠为 1 行（对标 cc）：正文存在则独占其余视口，否则正文预算为 0。
    return {
      thinkingLines: 1,
      textLines: hasText ? Math.max(MIN_STREAM_LINES, avail - 1) : 0,
    };
  }
  if (hasText) return { thinkingLines: 0, textLines: avail };
  return { thinkingLines: 0, textLines: 0 };
}

/**
 * 块感知的尾部截断（P1-C）：按 markdown 块边界裁出尾部可见内容，
 * 使其按 width 软换行后渲染高度 <= maxLines，且**不从块中间起头**
 * （表格 / 代码块 / 段落要么整块保留、要么整块丢弃）。
 *
 * 对比 tailToFit（按物理行尾部硬截断，会把表格/代码块拦腰截断退化成裸文本）：
 * 本函数用 cachedLexer 把文本切成块，从最后一块往前累加整块，直到再加一块就超预算。
 *
 * 退化处理：
 * - maxLines <= 0 或空串 → 空串。
 * - 一块都放不下（最后一块自身就超高，如超长代码块）→ 对最后一块退回 tailToFit
 *   做物理行尾部截断，保证仍有内容可见且不超高（瞬时视图，完成后进 Static 看全文）。
 *
 * 解析成本：cachedLexer 带 token 缓存，流式中同前缀重复 lex 命中缓存；
 * 即便未命中，块级窗口也把渲染规模约束到 O(视口高度)。
 */
export function tailToFitByBlocks(
  text: string,
  width: number,
  maxLines: number,
): string {
  if (maxLines <= 0 || !text) return "";
  const w = Math.max(1, width);

  // 用 token.raw 还原每个块的原始文本。marked 的 lexer 保证 raw 拼接 == 原文，
  // 所以按块切分不丢字符。空白 token（type==="space"）也带 raw，原样保留块间空行。
  let tokens: { raw?: string }[];
  try {
    tokens = cachedLexer(text) as { raw?: string }[];
  } catch {
    // lexer 异常 → 退回物理行截断，保证健壮
    return tailToFit(text, width, maxLines);
  }

  const blocks = tokens.map((t) => t.raw ?? "").filter((r) => r.length > 0);
  if (blocks.length === 0) return tailToFit(text, width, maxLines);

  // 从最后一块往前累加整块，直到再加一块就超预算。
  let used = 0;
  let startIdx = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const h = wrappedHeight(blocks[i], w);
    if (used + h > maxLines) break;
    used += h;
    startIdx = i;
  }

  // 至少有一整块能放下：返回尾部若干整块（去掉拼接处可能多出的首尾空白）。
  if (startIdx < blocks.length) {
    return blocks.slice(startIdx).join("").replace(/^\n+/, "").replace(/\n+$/, "");
  }

  // 一块都放不下（最后一块自身超高）：对最后一块退回物理行尾部截断。
  return tailToFit(blocks[blocks.length - 1], w, maxLines);
}
