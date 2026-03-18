/**
 * Markdown 终端渲染
 * 使用 marked.lexer() 获取 token AST，自定义递归渲染器生成 ANSI 字符串
 *
 * 支持的渲染效果：
 * - **加粗**、*斜体*、~~删除线~~、`行内代码`
 * - # 标题（h1 加粗斜体下划线，h2+ 加粗）
 * - > 引用（│ 前缀 + 斜体）
 * - 代码块语法高亮（cli-highlight，指定语言时启用）
 * - 表格（自绘 box-drawing，统一 string-width 宽度计算）
 * - 链接（OSC 8 超链接 + 蓝色下划线）
 * - 有序/无序列表（嵌套缩进，有序按深度循环数字/字母/罗马）
 * - 水平分割线
 */

import chalk from "chalk";
import { marked } from "marked";
import { highlight as cliHighlight, supportsLanguage } from "cli-highlight";
import stringWidth from "string-width";
import { getLogger } from "../debug/logger.ts";

// ── 常量 ────────────────────────────────────────────────────────
const DEFAULT_TERM_WIDTH = 80;
const MAX_RENDER_WIDTH = 120;
const TAB_SIZE = 2;
const TAB_INDENT = " ".repeat(TAB_SIZE);
const MAX_CACHE_SIZE = 100;

/** 当前渲染可用宽度（由 renderMarkdown 设置，renderTable 读取） */
let currentRenderWidth = DEFAULT_TERM_WIDTH;

// 兜底：cli.ts 入口已在 import 前设置 FORCE_COLOR=3，
// 这里再修正 chalk 实例的 level，确保样式正常。
if (chalk.level === 0 && !process.env.NO_COLOR) {
  chalk.level = 3;
}

/** 获取终端宽度 */
function getTermWidth(): number {
  return process.stdout.columns || DEFAULT_TERM_WIDTH;
}

// ── 代码高亮 ────────────────────────────────────────────────────
const codeHighlightTheme: Record<string, (s: string) => string> = {
  keyword: chalk.blue,
  built_in: chalk.cyan,
  type: chalk.cyan.dim,
  literal: chalk.blue,
  number: chalk.green,
  regexp: chalk.red,
  string: chalk.green,
  subst: chalk.white,
  symbol: chalk.green,
  class: chalk.blue,
  function: chalk.yellow,
  title: chalk.yellow,
  params: chalk.white,
  comment: chalk.gray,
  doctag: chalk.green,
  meta: chalk.gray,
  "meta-keyword": chalk.gray,
  "meta-string": chalk.gray,
  section: chalk.green,
  tag: chalk.gray,
  name: chalk.blue,
  "builtin-name": chalk.blue,
  attr: chalk.cyan,
  attribute: chalk.cyan,
  variable: chalk.red,
  bullet: chalk.green,
  code: chalk.green,
  emphasis: chalk.italic,
  strong: chalk.bold,
  formula: chalk.green,
  link: chalk.blue.underline,
  quote: chalk.gray.italic,
  "selector-tag": chalk.blue,
  "selector-id": chalk.blue,
  "selector-class": chalk.blue,
  "selector-attr": chalk.cyan,
  "selector-pseudo": chalk.cyan,
  "template-tag": chalk.cyan,
  "template-variable": chalk.cyan,
  addition: chalk.green,
  deletion: chalk.red,
  default: chalk.white,
};

/** 代码块高亮：只在指定语言时启用，无语言时不做 auto-detect 避免误判 */
function highlightCode(code: string, lang?: string): string {
  if (!lang || !supportsLanguage(lang)) {
    return code;
  }
  try {
    return cliHighlight(code, {
      language: lang,
      ignoreIllegals: true,
      theme: codeHighlightTheme,
    });
  } catch {
    return code;
  }
}

// ── 自定义表格渲染 ──────────────────────────────────────────────

const MIN_COL_WIDTH = 8;
const MAX_TABLE_COLS = 6;
/** 每列左右各 1 空格 padding */
const CELL_PADDING = 2;

/** 计算字符串的终端可见列宽（去除 ANSI 转义码，CJK 字符占 2 列） */
function visibleWidth(s: string): number {
  return stringWidth(s);
}

// ── ANSI 转义码正则 ──────────────────────────────────────────────
const ANSI_RE = /\x1b\[[\d;]*m/g;

/**
 * CJK 感知的文本换行
 * - 按 \n 分割后逐字符遍历，用 stringWidth 累计宽度
 * - CJK 字符可在任意字符边界换行
 * - 正确跳过 ANSI 转义码（不计入宽度）
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") { result.push(""); continue; }
    // 检测是否含 ANSI 转义码
    const hasAnsi = ANSI_RE.test(paragraph);
    ANSI_RE.lastIndex = 0; // 重置 lastIndex

    if (!hasAnsi) {
      // 快速路径：无 ANSI 码，直接遍历字符
      let line = "";
      let lineWidth = 0;
      for (const ch of paragraph) {
        const cw = stringWidth(ch);
        if (lineWidth + cw > maxWidth && lineWidth > 0) {
          result.push(line);
          line = ch;
          lineWidth = cw;
        } else {
          line += ch;
          lineWidth += cw;
        }
      }
      if (line) result.push(line);
    } else {
      // 慢速路径：需要跳过 ANSI 转义码
      // TODO: 断行时未继承 ANSI 样式状态，跨行样式会丢失（当前场景影响极小，cell 内容通常不跨行）
      let line = "";
      let lineWidth = 0;
      let i = 0;
      while (i < paragraph.length) {
        // 尝试匹配 ANSI 转义码
        ANSI_RE.lastIndex = i;
        const m = ANSI_RE.exec(paragraph);
        if (m && m.index === i) {
          // ANSI 码直接追加，不计宽度
          line += m[0];
          i += m[0].length;
          continue;
        }
        // 普通字符（可能是多字节）
        const cp = paragraph.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        const cw = stringWidth(ch);
        if (lineWidth + cw > maxWidth && lineWidth > 0) {
          result.push(line);
          line = ch;
          lineWidth = cw;
        } else {
          line += ch;
          lineWidth += cw;
        }
        i += ch.length;
      }
      if (line) result.push(line);
    }
  }
  return result;
}

// ── 自绘表格（box-drawing） ─────────────────────────────────────

/** 右侧补空格，使 visibleWidth 达到 targetWidth */
function padRight(text: string, targetWidth: number): string {
  const w = visibleWidth(text);
  const pad = targetWidth - w;
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** 绘制水平分隔线 */
function hLine(colWidths: number[], left: string, mid: string, right: string): string {
  return left + colWidths.map(w => "─".repeat(w + CELL_PADDING)).join(mid) + right;
}

/** 绘制内容行（支持多行 cell） */
function contentRows(cells: string[][], colWidths: number[], isBold: boolean): string[] {
  // cells[col] = wrapText 后的行数组
  const maxLines = Math.max(...cells.map(c => c.length), 1);
  const lines: string[] = [];
  for (let l = 0; l < maxLines; l++) {
    let row = "│";
    for (let c = 0; c < colWidths.length; c++) {
      const text = cells[c]?.[l] || "";
      const display = isBold ? chalk.bold(text) : text;
      row += " " + padRight(display, colWidths[c]) + " │";
    }
    lines.push(row);
  }
  return lines;
}

/** 用 box-drawing 字符绘制完整表格 */
function drawTable(
  headers: string[][],   // headers[col] = wrapText 后的行数组
  rows: string[][][],    // rows[row][col] = wrapText 后的行数组
  colWidths: number[],   // 每列纯内容宽度
): string {
  const lines: string[] = [];
  // 顶部边框
  lines.push(hLine(colWidths, "┌", "┬", "┐"));
  // 表头
  lines.push(...contentRows(headers, colWidths, true));
  // 表头分隔线
  lines.push(hLine(colWidths, "├", "┼", "┤"));
  // 数据行
  for (let r = 0; r < rows.length; r++) {
    lines.push(...contentRows(rows[r], colWidths, false));
    if (r < rows.length - 1) {
      lines.push(hLine(colWidths, "├", "┼", "┤"));
    }
  }
  // 底部边框
  lines.push(hLine(colWidths, "└", "┴", "┘"));
  return lines.join("\n");
}

/** 将 marked table token 渲染为终端友好的表格或 key-value 降级格式 */
function renderTable(token: any): string {
  const headers: string[] = token.header.map((cell: any) =>
    cell.tokens ? renderInline(cell.tokens) : (cell.text || ""),
  );
  const rows: string[][] = token.rows.map((row: any[]) =>
    row.map((cell: any) =>
      cell.tokens ? renderInline(cell.tokens) : (cell.text || ""),
    ),
  );
  const colCount = headers.length;
  const termWidth = currentRenderWidth;

  // 总表格宽度 = Σ(contentWidth[i] + CELL_PADDING) + colCount + 1
  // contentBudget = termWidth - colCount * (CELL_PADDING + 1) - 1
  const contentBudget = termWidth - colCount * (CELL_PADDING + 1) - 1;

  if (colCount > MAX_TABLE_COLS || contentBudget / colCount < MIN_COL_WIDTH) {
    return renderKeyValue(headers, rows, termWidth);
  }

  // 计算每列自然内容宽度
  const maxContentWidths = headers.map((h: string, i: number) => {
    let max = visibleWidth(h);
    for (const row of rows) {
      if (row[i] !== undefined) {
        max = Math.max(max, visibleWidth(row[i]));
      }
    }
    return max;
  });

  const totalContent = maxContentWidths.reduce((a, b) => a + b, 0);
  let colWidths: number[];

  if (totalContent <= contentBudget) {
    // 内容不超宽，每列按实际内容宽度
    colWidths = maxContentWidths.slice();
  } else {
    // 按比例压缩分配纯内容宽度
    colWidths = maxContentWidths.map((w: number) => {
      const ratio = w / totalContent;
      return Math.max(MIN_COL_WIDTH, Math.floor(contentBudget * ratio));
    });

    // 分配剩余空间给最宽的列
    const allocated = colWidths.reduce((a, b) => a + b, 0);
    let remaining = contentBudget - allocated;
    while (remaining > 0) {
      let maxIdx = 0;
      for (let i = 1; i < colWidths.length; i++) {
        if (colWidths[i] > colWidths[maxIdx]) maxIdx = i;
      }
      colWidths[maxIdx]++;
      remaining--;
    }
  }

  // 验证总宽度不超终端
  const totalTableWidth = colWidths.reduce((a, b) => a + b, 0) + colCount * (CELL_PADDING + 1) + 1;
  if (totalTableWidth > termWidth) {
    return renderKeyValue(headers, rows, termWidth);
  }

  // 对每个 cell 调用 wrapText 换行
  const wrappedHeaders: string[][] = headers.map((h, i) => wrapText(h, colWidths[i]));
  const wrappedRows: string[][][] = rows.map(row =>
    row.map((cell, i) => wrapText(cell, colWidths[i])),
  );

  return "\n" + drawTable(wrappedHeaders, wrappedRows, colWidths) + "\n";
}

/** key-value 竖排降级格式 */
function renderKeyValue(headers: string[], rows: string[][], termWidth: number): string {
  const separator = chalk.gray("─".repeat(Math.min(termWidth - 2, 40)));
  const lines: string[] = [""];

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < headers.length; c++) {
      const key = chalk.bold(headers[c]);
      const value = rows[r][c] || "";
      lines.push(`${key}: ${value}`);
    }
    if (r < rows.length - 1) {
      lines.push("", separator, "");
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ── 有序列表辅助函数 ────────────────────────────────────────────

/** 数字转小写字母：1→a, 2→b, ..., 26→z, 27→aa */
function toAlpha(n: number): string {
  let result = "";
  let num = n;
  while (num > 0) {
    num--;
    result = String.fromCharCode(97 + (num % 26)) + result;
    num = Math.floor(num / 26);
  }
  return result;
}

/** 数字转小写罗马数字 */
function toRoman(n: number): string {
  const values = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const symbols = ["m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i"];
  let result = "";
  let num = n;
  for (let i = 0; i < values.length; i++) {
    while (num >= values[i]) {
      result += symbols[i];
      num -= values[i];
    }
  }
  return result;
}

/** 按嵌套深度格式化有序列表前缀：depth 0 数字，depth 1 字母，depth 2 罗马 */
function formatOrderedPrefix(num: number, depth: number): string {
  switch (depth % 3) {
    case 0: return `${num}.`;
    case 1: return `${toAlpha(num)}.`;
    case 2: return `${toRoman(num)}.`;
    default: return `${num}.`;
  }
}

// ── OSC 8 超链接 ────────────────────────────────────────────────

/** 渲染 OSC 8 终端超链接 */
function renderLink(label: string, href: string): string {
  const styledLabel = chalk.blue.underline(label);
  return `\x1b]8;;${href}\x1b\\${styledLabel}\x1b]8;;\x1b\\`;
}

// ── 内联 token 递归渲染 ─────────────────────────────────────────

/** 递归渲染内联 token 数组为 ANSI 字符串 */
function renderInline(tokens: any[]): string {
  let result = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        result += token.tokens ? renderInline(token.tokens) : token.text;
        break;
      case "strong":
        result += chalk.bold(renderInline(token.tokens));
        break;
      case "em":
        result += chalk.italic(renderInline(token.tokens));
        break;
      case "codespan":
        result += chalk.cyan(token.text);
        break;
      case "del":
        result += chalk.dim.gray.strikethrough(renderInline(token.tokens));
        break;
      case "link":
        result += renderLink(
          token.tokens ? renderInline(token.tokens) : token.text,
          token.href,
        );
        break;
      case "image":
        result += token.href || token.text;
        break;
      case "br":
        result += "\n";
        break;
      case "escape":
        result += token.text;
        break;
      case "html":
        result += token.text;
        break;
      default:
        result += token.raw || token.text || "";
        break;
    }
  }
  return result;
}

// ── 列表渲染 ────────────────────────────────────────────────────

/** 递归渲染列表（支持嵌套） */
function renderList(token: any, depth: number = 0): string {
  const indent = TAB_INDENT.repeat(depth);
  const lines: string[] = [];

  for (let i = 0; i < token.items.length; i++) {
    const item = token.items[i];
    const prefix = token.ordered
      ? `${formatOrderedPrefix((token.start || 1) + i, depth)} `
      : "- ";

    // 收集当前列表项的内容
    const parts: string[] = [];
    for (const child of item.tokens) {
      if (child.type === "text") {
        parts.push(child.tokens ? renderInline(child.tokens) : child.text);
      } else if (child.type === "paragraph") {
        parts.push(renderInline(child.tokens));
      } else if (child.type === "list") {
        // 嵌套列表单独处理
        parts.push("\n" + renderList(child, depth + 1));
      } else {
        // 其他块级元素（代码块等）
        parts.push(renderTokens([child]));
      }
    }

    const content = parts.join("");
    // 第一行带前缀，后续行对齐
    const firstLine = `${indent}${prefix}${content.split("\n")[0]}`;
    const restLines = content.split("\n").slice(1).map(line => {
      // 嵌套列表已经有自己的缩进，不需要额外对齐
      if (line.startsWith(TAB_INDENT.repeat(depth + 1))) return line;
      return line;
    });

    lines.push(firstLine);
    if (restLines.length > 0) {
      lines.push(...restLines);
    }
  }

  return lines.join("\n");
}

// ── 块级 token 渲染 ─────────────────────────────────────────────

/** 递归渲染块级 token 数组为 ANSI 字符串 */
function renderTokens(tokens: any[]): string {
  const blocks: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const text = renderInline(token.tokens);
        if (token.depth === 1) {
          blocks.push(chalk.bold.italic.underline(text));
        } else {
          blocks.push(chalk.bold(text));
        }
        break;
      }
      case "paragraph": {
        blocks.push(renderInline(token.tokens));
        break;
      }
      case "code": {
        const highlighted = highlightCode(token.text, token.lang);
        const indented = highlighted
          .split("\n")
          .map((line: string) => TAB_INDENT + line)
          .join("\n");
        blocks.push(indented);
        break;
      }
      case "blockquote": {
        const inner = renderTokens(token.tokens);
        const quoted = inner
          .split("\n")
          .map((line: string) => chalk.dim("│") + " " + chalk.italic(line))
          .join("\n");
        blocks.push(quoted);
        break;
      }
      case "list": {
        blocks.push(renderList(token));
        break;
      }
      case "table": {
        blocks.push(renderTable(token));
        break;
      }
      case "hr": {
        blocks.push("---");
        break;
      }
      case "html": {
        const trimmed = token.text.trim();
        if (trimmed) blocks.push(chalk.gray(trimmed));
        break;
      }
      case "space": {
        // 块间距由 \n\n 连接处理，跳过
        break;
      }
      default: {
        // 未知 token 类型，输出原始文本
        if (token.raw) blocks.push(token.raw);
        break;
      }
    }
  }

  return blocks.join("\n\n");
}

// ── 渲染缓存 + 宽度检测 ─────────────────────────────────────────
const renderCache = new Map<string, string>();
let lastWidth = 0;

/** 将 Markdown 文本渲染为终端格式
 * @param maxWidth 可选，指定渲染可用宽度（用于表格等宽度敏感元素）
 */
export function renderMarkdown(text: string, maxWidth?: number): string {
  // 终端宽度变化时清空缓存
  const w = getTermWidth();
  const effectiveWidth = Math.min(maxWidth ?? w, MAX_RENDER_WIDTH, w);
  if (w !== lastWidth) {
    renderCache.clear();
    lastWidth = w;
  }

  // 缓存 key 需要包含宽度，因为同一文本在不同宽度下渲染结果不同
  const cacheKey = `${effectiveWidth}:${text}`;
  if (renderCache.has(cacheKey)) {
    return renderCache.get(cacheKey)!;
  }

  const log = getLogger();

  // 设置当前渲染宽度供 renderTable 使用
  currentRenderWidth = effectiveWidth;

  try {
    log.debug("UI:MD", `renderMarkdown 开始: textLen=${text.length} effectiveWidth=${effectiveWidth} textPreview=${JSON.stringify(text.slice(0, 100))}`);
    const tokens = marked.lexer(text);
    log.debug("UI:MD", `marked.lexer 完成: tokenCount=${tokens.length} tokenTypes=${tokens.map((t: any) => t.type).join(",")}`);
    const result = renderTokens(tokens).trimEnd();
    log.debug("UI:MD", `renderTokens 完成: resultLen=${result.length} hasAnsi=${/\x1b\[/.test(result)} resultPreview=${JSON.stringify(result.slice(0, 100))}`);

    if (renderCache.size >= MAX_CACHE_SIZE) {
      const firstKey = renderCache.keys().next().value;
      if (firstKey !== undefined) renderCache.delete(firstKey);
      log.debug("UI:MD", `缓存已满，淘汰最旧条目，当前 ${renderCache.size} 条`);
    }
    renderCache.set(cacheKey, result);

    return result;
  } catch (err: any) {
    log.error("UI:MD", `Markdown 渲染失败`, { error: err.message, stack: err.stack, textLen: text.length, textPreview: text.slice(0, 100) });
    return text;
  }
}
