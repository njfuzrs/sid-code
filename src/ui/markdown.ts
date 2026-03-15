/**
 * Markdown 终端渲染
 * 使用 marked + marked-terminal 将 Markdown 渲染为终端格式
 *
 * 支持的渲染效果：
 * - **加粗**、*斜体*、~~删除线~~、`行内代码`
 * - # 标题（一级紫色下划线加粗，二级+绿色加粗）
 * - > 引用（灰色斜体）
 * - 代码块语法高亮（cli-highlight，自动检测语言）
 * - 表格（cli-table3 box-drawing，自动适配终端宽度）
 * - 链接（蓝色 + 下划线 URL）
 * - 有序/无序列表
 * - 水平分割线
 * - :emoji: 表情符号
 */

import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { getLogger } from "../debug/logger.ts";

// 兜底：cli.ts 入口已在 import 前设置 FORCE_COLOR=3，
// 这里再修正 chalk 实例的 level，确保 marked-terminal 的样式正常。
if (chalk.level === 0 && !process.env.NO_COLOR) {
  chalk.level = 3;
}

/** 获取终端宽度 */
function getTermWidth(): number {
  return process.stdout.columns || 80;
}

// 配置 marked 使用终端渲染器（完整样式 + 代码高亮）
marked.use(
  markedTerminal(
    {
      // 样式配置
      firstHeading: chalk.magenta.underline.bold,
      heading: chalk.green.bold,
      strong: chalk.bold,
      em: chalk.italic,
      codespan: chalk.cyan,
      del: chalk.dim.gray.strikethrough,
      code: chalk.yellow,
      blockquote: chalk.gray.italic,
      link: chalk.blue,
      href: chalk.blue.underline,
      hr: chalk.gray,
      listitem: chalk.reset,
      table: chalk.reset,
      paragraph: chalk.reset,
      html: chalk.gray,
      // 格式配置
      reflowText: true,
      width: Math.min(getTermWidth(), 120),
      showSectionPrefix: false,
      tab: 2,
      unescape: true,
      emoji: true,
    },
    // cli-highlight 代码高亮选项
    {
      ignoreIllegals: true,
    },
  ) as any,
);

// 渲染缓存（避免重复渲染相同内容）
// key = 原始文本 + 终端宽度，避免终端 resize 后缓存失效
const renderCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

/**
 * 计算字符串的可见宽度（中文等 CJK 字符占 2 列宽）
 */
function visibleWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
      (code >= 0x3000 && code <= 0x303F) ||   // CJK Symbols and Punctuation
      (code >= 0xFF00 && code <= 0xFFEF) ||   // Fullwidth Forms
      (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
      (code >= 0x20000 && code <= 0x2A6DF) || // CJK Extension B
      (code >= 0xF900 && code <= 0xFAFF) ||   // CJK Compatibility Ideographs
      (code >= 0x2E80 && code <= 0x2EFF) ||   // CJK Radicals Supplement
      (code >= 0x2F00 && code <= 0x2FDF) ||   // Kangxi Radicals
      (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
      (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
      (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul Syllables
      (code >= 0xFE30 && code <= 0xFE4F)      // CJK Compatibility Forms
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** 截断字符串到指定可见宽度，末尾加 … */
function truncateToWidth(str: string, maxW: number): string {
  if (visibleWidth(str) <= maxW) return str;
  let w = 0;
  let cutIdx = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    const cw =
      (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF) || (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) || (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF) ||
      (code >= 0xAC00 && code <= 0xD7AF) || (code >= 0xFE30 && code <= 0xFE4F)
        ? 2 : 1;
    if (w + cw > maxW - 1) break; // 留 1 位给 …
    w += cw;
    cutIdx += ch.length;
  }
  return str.slice(0, cutIdx) + "…";
}

/**
 * 预处理 Markdown 源文本中的表格，确保 cli-table3 渲染后不超过终端宽度。
 * 检测 Markdown 表格行（| xxx | xxx |），计算各列宽度，
 * 如果总宽度超过 maxWidth 则智能截短最宽的列。
 */
function preprocessMarkdownTable(md: string, maxWidth: number): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let tableLines: string[] = [];
  let inTable = false;

  const isTableRow = (line: string) => /^\|.*\|$/.test(line.trim());
  const isSeparator = (line: string) => /^\|[\s\-:|]+\|$/.test(line.trim());

  for (const line of lines) {
    if (isTableRow(line) || isSeparator(line)) {
      if (!inTable) inTable = true;
      tableLines.push(line);
    } else {
      if (inTable) {
        result.push(...truncateTableCells(tableLines, maxWidth));
        tableLines = [];
        inTable = false;
      }
      result.push(line);
    }
  }
  if (tableLines.length > 0) {
    result.push(...truncateTableCells(tableLines, maxWidth));
  }
  return result.join("\n");
}

/** 截短表格单元格，使 cli-table3 渲染后总宽度不超过 maxWidth */
function truncateTableCells(lines: string[], maxWidth: number): string[] {
  // 解析每行的单元格
  const rows = lines.map(line => {
    const trimmed = line.trim();
    return trimmed.slice(1, -1).split("|").map(cell => cell.trim());
  });
  if (rows.length < 2) return lines;

  const colCount = rows[0].length;
  const colWidths = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < Math.min(row.length, colCount); i++) {
      // 跳过分隔行（全是 - : 空格）
      if (/^[\-:\s]+$/.test(row[i])) continue;
      const w = visibleWidth(row[i]);
      if (w > colWidths[i]) colWidths[i] = w;
    }
  }

  // cli-table3 每列开销：左 padding(1) + 右 padding(1) + 右边框(1) = 3，加最左边框 1
  const overhead = colCount * 3 + 1;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + overhead;

  if (totalWidth <= maxWidth) return lines; // 不需要截断

  const availableContent = maxWidth - overhead;
  if (availableContent < colCount * 3) return lines; // 太窄，放弃截断

  // 优先截断最宽的列，逐步缩减到第二宽的列宽度
  const targetWidths = [...colWidths];
  let currentTotal = colWidths.reduce((a, b) => a + b, 0);

  while (currentTotal > availableContent) {
    let maxIdx = 0;
    for (let i = 1; i < targetWidths.length; i++) {
      if (targetWidths[i] > targetWidths[maxIdx]) maxIdx = i;
    }
    let secondMax = 0;
    for (let i = 0; i < targetWidths.length; i++) {
      if (i !== maxIdx && targetWidths[i] > secondMax) secondMax = targetWidths[i];
    }
    const newWidth = Math.max(secondMax, Math.min(targetWidths[maxIdx] - 1, 10));
    if (newWidth >= targetWidths[maxIdx]) {
      // 所有列一样宽，均匀分配
      for (let i = 0; i < targetWidths.length; i++) {
        targetWidths[i] = Math.max(3, Math.floor(availableContent / colCount));
      }
      break;
    }
    currentTotal -= (targetWidths[maxIdx] - newWidth);
    targetWidths[maxIdx] = newWidth;
  }

  // 重建表格行
  return lines.map(line => {
    const trimmed = line.trim();
    // 分隔行：重建为对应宽度的 ---
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
      const cells = targetWidths.map(w => "-".repeat(w));
      return "| " + cells.join(" | ") + " |";
    }
    // 数据行：截短超宽单元格
    const inner = trimmed.slice(1, -1);
    const cells = inner.split("|").map(cell => cell.trim());
    const truncated = cells.map((cell, i) => {
      const maxW = targetWidths[i] || 10;
      return visibleWidth(cell) <= maxW ? cell : truncateToWidth(cell, maxW);
    });
    return "| " + truncated.join(" | ") + " |";
  });
}

/** 检测 Markdown 文本是否包含表格 */
function hasMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  let hasRow = false;
  let hasSep = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.*\|$/.test(trimmed)) {
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) hasSep = true;
      else hasRow = true;
    }
    if (hasRow && hasSep) return true;
  }
  return false;
}

/** 将 Markdown 文本渲染为终端格式 */
export function renderMarkdown(text: string): string {
  const termWidth = getTermWidth();
  const cacheKey = `${termWidth}:${text}`;

  // 检查缓存
  if (renderCache.has(cacheKey)) {
    return renderCache.get(cacheKey)!;
  }

  const log = getLogger();

  try {
    // 如果包含表格，先预处理确保不超过终端宽度
    const processed = hasMarkdownTable(text)
      ? preprocessMarkdownTable(text, termWidth)
      : text;

    const rendered = marked.parse(processed);
    const result = typeof rendered === "string" ? rendered.trimEnd() : text;

    // 添加到缓存（限制缓存大小）
    if (renderCache.size >= MAX_CACHE_SIZE) {
      const firstKey = renderCache.keys().next().value;
      if (firstKey !== undefined) renderCache.delete(firstKey);
      log.debug("UI:MD", `缓存已满，淘汰最旧条目，当前 ${renderCache.size} 条`);
    }
    renderCache.set(cacheKey, result);

    return result;
  } catch (err: any) {
    log.error("UI:MD", `Markdown 渲染失败`, { error: err.message, textLen: text.length, textPreview: text.slice(0, 100) });
    return text;
  }
}
