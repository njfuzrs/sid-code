/**
 * 主屏 Static 模式流式视口裁剪（ADR-040 防闪烁）
 *
 * 背景：stock @jrichman/ink 主屏渲染路径在「动态区(非 Static)渲染高度 >= 终端行数」时
 * 退化为每帧 clearTerminal + 重打全部内容（node_modules/ink/build/ink.js:276）。
 * 流式回复一旦超过一屏，30fps 下即触发全屏闪烁/疯狂刷屏。
 *
 * 我们用的不是 claude-code 的自研 fork renderer（它自己做行级 diff、从不 clearTerminal），
 * 搬不过来。因此唯一正解：把动态区里会随流式增长的内容（流式正文 / 思考）按可用视口高度
 * 做「尾部截断」—— 只渲染最新的若干行，保证动态区高度始终 < 终端行数。
 *
 * 流式完成后整条消息并入 historyItems → 进 <Static> 打印进终端 scrollback（完整内容、可原生上滚回看）。
 * 所以「流式中看尾部、完成后看全文」与 claude-code 的 log-update 小动态区模型一致。
 */

import stringWidth from "string-width";

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

/** 底部固定 chrome（Composer + Footer + padding + slack）的基础预留行数 */
const BASE_CHROME_LINES = 8;

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
 * - 总可用 = max(MIN_STREAM_LINES, rows - chrome)
 * - 思考与正文并存时：思考占约 1/3（至少 2 行），正文占其余；正文优先。
 * - 仅其一存在：独占全部预算。
 */
export function computeStreamBudgets(
  rows: number,
  chromeLines: number,
  hasThinking: boolean,
  hasText: boolean,
): { thinkingLines: number; textLines: number } {
  const MIN_STREAM_LINES = 3;
  const avail = Math.max(MIN_STREAM_LINES, rows - chromeLines);

  if (hasThinking && hasText) {
    const thinkingLines = Math.max(2, Math.floor(avail / 3));
    return { thinkingLines, textLines: Math.max(MIN_STREAM_LINES, avail - thinkingLines) };
  }
  if (hasThinking) return { thinkingLines: avail, textLines: 0 };
  if (hasText) return { thinkingLines: 0, textLines: avail };
  return { thinkingLines: 0, textLines: 0 };
}
