/**
 * Markdown 终端渲染
 * 使用 marked.lexer() 获取 token AST，自定义递归渲染器生成 ANSI 字符串
 *
 * 支持的渲染效果：
 * - **加粗**、*斜体*、~~删除线~~、`行内代码`
 * - # 标题（h1 加粗斜体下划线，h2+ 加粗）
 * - > 引用（│ 前缀 + 斜体）
 * - 代码块语法高亮（cli-highlight，指定语言时启用）
 * - 表格（cli-table3 box-drawing）
 * - 链接（OSC 8 超链接 + 蓝色下划线）
 * - 有序/无序列表（嵌套缩进，有序按深度循环数字/字母/罗马）
 * - 水平分割线
 */

import chalk from "chalk";
import { marked } from "marked";
import { highlight as cliHighlight, supportsLanguage } from "cli-highlight";
import Table from "cli-table3";
import stripAnsi from "strip-ansi";
import { getLogger } from "../debug/logger.ts";

// ── 常量 ────────────────────────────────────────────────────────
const DEFAULT_TERM_WIDTH = 80;
const MAX_RENDER_WIDTH = 120;
const TAB_SIZE = 2;
const TAB_INDENT = " ".repeat(TAB_SIZE);
const MAX_CACHE_SIZE = 100;

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
const BORDER_OVERHEAD_PER_COL = 3;
const BORDER_OVERHEAD_EXTRA = 1;

/** 计算字符串的可见宽度（去除 ANSI 转义码） */
function visibleWidth(s: string): number {
  return stripAnsi(s).length;
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
  const termWidth = Math.min(getTermWidth(), MAX_RENDER_WIDTH);

  const maxContentWidths = headers.map((h: string, i: number) => {
    let max = visibleWidth(h);
    for (const row of rows) {
      if (row[i] !== undefined) {
        max = Math.max(max, visibleWidth(row[i]));
      }
    }
    return max;
  });

  const borderTotal = colCount * BORDER_OVERHEAD_PER_COL + BORDER_OVERHEAD_EXTRA;
  const availableWidth = termWidth - borderTotal;

  if (colCount > MAX_TABLE_COLS || availableWidth / colCount < MIN_COL_WIDTH) {
    return renderKeyValue(headers, rows, termWidth);
  }

  const totalContent = maxContentWidths.reduce((a: number, b: number) => a + b, 0);
  let colWidths: number[];

  if (totalContent <= availableWidth) {
    colWidths = maxContentWidths.map((w: number) => w + 2);
  } else {
    colWidths = maxContentWidths.map((w: number) => {
      const ratio = w / totalContent;
      return Math.max(MIN_COL_WIDTH, Math.floor(availableWidth * ratio));
    });

    const allocated = colWidths.reduce((a: number, b: number) => a + b, 0);
    let remaining = availableWidth - allocated;
    while (remaining > 0) {
      let maxIdx = 0;
      for (let i = 1; i < colWidths.length; i++) {
        if (colWidths[i] > colWidths[maxIdx]) maxIdx = i;
      }
      colWidths[maxIdx]++;
      remaining--;
    }

    colWidths = colWidths.map((w: number) => w + 2);
  }

  const totalTableWidth = colWidths.reduce((a: number, b: number) => a + b, 0) + colCount + 1;
  if (totalTableWidth > termWidth) {
    return renderKeyValue(headers, rows, termWidth);
  }

  try {
    const table = new Table({
      head: headers.map((h: string) => chalk.bold(h)),
      colWidths,
      wordWrap: true,
      style: { head: [], border: [], compact: false },
    });
    for (const row of rows) {
      table.push(row);
    }
    return "\n" + table.toString() + "\n";
  } catch {
    return renderKeyValue(headers, rows, termWidth);
  }
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

/** 将 Markdown 文本渲染为终端格式 */
export function renderMarkdown(text: string): string {
  // 终端宽度变化时清空缓存
  const w = getTermWidth();
  if (w !== lastWidth) {
    renderCache.clear();
    lastWidth = w;
  }

  if (renderCache.has(text)) {
    return renderCache.get(text)!;
  }

  const log = getLogger();

  try {
    const tokens = marked.lexer(text);
    const result = renderTokens(tokens).trimEnd();

    if (renderCache.size >= MAX_CACHE_SIZE) {
      const firstKey = renderCache.keys().next().value;
      if (firstKey !== undefined) renderCache.delete(firstKey);
      log.debug("UI:MD", `缓存已满，淘汰最旧条目，当前 ${renderCache.size} 条`);
    }
    renderCache.set(text, result);

    return result;
  } catch (err: any) {
    log.error("UI:MD", `Markdown 渲染失败`, { error: err.message, textLen: text.length, textPreview: text.slice(0, 100) });
    return text;
  }
}
