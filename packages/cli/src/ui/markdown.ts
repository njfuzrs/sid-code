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
import { marked, type Token } from "marked";
import { highlight as cliHighlight, supportsLanguage } from "cli-highlight";
import stringWidth from "string-width";
import { supportsHyperlinks } from "@sid-code/tui-renderer/supports-hyperlinks.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { theme } from "./semantic-colors.ts";
import { themeManager } from "./themes/theme-manager.ts";

// ── 常量 ────────────────────────────────────────────────────────
// 终端宽度 fallback（仅在 process.stdout.columns 不可用时使用）
export const DEFAULT_TERM_WIDTH = 80;
// 移除 MAX_RENDER_WIDTH 硬编码限制，改为动态计算
const TAB_SIZE = 2;
const TAB_INDENT = " ".repeat(TAB_SIZE);
const MAX_CACHE_SIZE = 100;

// 兜底：cli.ts 入口已在 import 前设置 FORCE_COLOR=3，
// 这里再修正 chalk 实例的 level，确保样式正常。
if (chalk.level === 0 && !process.env.NO_COLOR) {
  chalk.level = 3;
}

// ── marked 一次性配置（P2-I：禁用删除线） ───────────────────────
// 模型常用 `~100` 表「约 100」，marked 默认会把 ~~...~~ 解析成删除线，
// 误把约数渲成删除线。对标 claude-code 的 configureMarked()，禁用 del tokenizer。
let markedConfigured = false;
export function configureMarked(): void {
  if (markedConfigured) return;
  markedConfigured = true;
  marked.use({
    tokenizer: {
      del() {
        return undefined;
      },
    },
  });
}

// ── token 级缓存（P1-D，对标 cc Markdown.tsx:22-71） ─────────────
// marked.lexer 是流式/虚拟滚动重挂载时的热点(~3ms/条)。消息内容在历史里不可变，
// 同内容→同 token，按 hash key 缓存避免反复 lex。module-level，跨 unmount/remount 存活。
const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map<string, Token[]>();

// FNV-1a 32-bit 字符串 hash（本项目无 hash 工具，自带轻量实现，避免引外部依赖）。
// 用 hash 而非「内容前缀+长度」做 key，规避长内容前缀相同导致的碰撞。
function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619，用移位避免溢出为浮点
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // 叠加长度降低碰撞概率
  return `${h.toString(36)}:${s.length}`;
}

// markdown 语法特征字符。无任何特征→跳过 ~3ms 的 marked.lexer，直接当单 paragraph。
// 覆盖大多数纯文本短回复 / 用户输入。对标 cc hasMarkdownSyntax。
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s: string): boolean {
  // 采样前 500 字符：markdown 特征通常出现在开头(标题/代码围栏/列表)，
  // 长工具输出多为纯文本尾巴。
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

/**
 * 带缓存的 marked.lexer（P1-D）。
 * - 纯文本快速路径：无 markdown 语法 → 直接构造单 paragraph token，跳过 lexer。
 *   该 token 不入缓存（重建只是一次对象分配，缓存它反而徒增内存）。
 * - 其余：按内容 hash 命中缓存(LRU 提升)，未命中则 lex 并写入(满则淘汰最旧)。
 */
export function cachedLexer(content: string): Token[] {
  configureMarked();
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: "paragraph",
        raw: content,
        text: content,
        tokens: [{ type: "text", raw: content, text: content }],
      } as unknown as Token,
    ];
  }
  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) {
    // 提升为最近使用，避免 FIFO 淘汰掉正在回看的早期消息
    tokenCache.delete(key);
    tokenCache.set(key, hit);
    return hit;
  }
  const tokens = marked.lexer(content);
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value;
    if (first !== undefined) tokenCache.delete(first);
  }
  tokenCache.set(key, tokens);
  return tokens;
}

/** 获取终端宽度 */
function getTermWidth(): number {
  return process.stdout.columns || DEFAULT_TERM_WIDTH;
}

// ── 代码高亮 ────────────────────────────────────────────────────
// 使用主题 hex 色（通过 chalk.hex）替代 ANSI 16 色名，确保浅色/深色终端下均可读。
// chalk.blue/cyan/white 等在浅色终端下的实际颜色完全取决于终端配色方案，不可控。
function getCodeHighlightTheme(): Record<string, (s: string) => string> {
  const colors = theme;
  const t = themeManager.getActiveTheme().colors;
  return {
    keyword: chalk.hex(t.AccentBlue),
    built_in: chalk.hex(t.AccentCyan),
    type: chalk.hex(t.AccentCyan),
    literal: chalk.hex(t.AccentBlue),
    number: chalk.hex(t.AccentGreen),
    regexp: chalk.hex(t.AccentRed),
    string: chalk.hex(t.AccentGreen),
    subst: chalk.hex(t.Foreground),
    symbol: chalk.hex(t.AccentGreen),
    class: chalk.hex(t.AccentBlue),
    function: chalk.hex(t.AccentYellow),
    title: chalk.hex(t.AccentYellow),
    params: chalk.hex(t.Foreground),
    comment: chalk.hex(t.Comment),
    doctag: chalk.hex(t.AccentGreen),
    meta: chalk.hex(t.Comment),
    "meta-keyword": chalk.hex(t.Comment),
    "meta-string": chalk.hex(t.Comment),
    section: chalk.hex(t.AccentGreen),
    tag: chalk.hex(t.Comment),
    name: chalk.hex(t.AccentBlue),
    "builtin-name": chalk.hex(t.AccentBlue),
    attr: chalk.hex(t.AccentCyan),
    attribute: chalk.hex(t.AccentCyan),
    variable: chalk.hex(t.AccentRed),
    bullet: chalk.hex(t.AccentGreen),
    code: chalk.hex(t.AccentGreen),
    emphasis: chalk.italic,
    strong: chalk.bold,
    formula: chalk.hex(t.AccentGreen),
    link: chalk.hex(colors.text.link).underline,
    quote: chalk.hex(t.Comment).italic,
    "selector-tag": chalk.hex(t.AccentBlue),
    "selector-id": chalk.hex(t.AccentBlue),
    "selector-class": chalk.hex(t.AccentBlue),
    "selector-attr": chalk.hex(t.AccentCyan),
    "selector-pseudo": chalk.hex(t.AccentCyan),
    "template-tag": chalk.hex(t.AccentCyan),
    "template-variable": chalk.hex(t.AccentCyan),
    addition: chalk.hex(t.AccentGreen),
    deletion: chalk.hex(t.AccentRed),
    default: chalk.hex(t.Foreground),
  };
}

/** 代码块高亮：指定语言时使用指定语言，未指定时尝试自动检测 */
function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && supportsLanguage(lang)) {
      return cliHighlight(code, {
        language: lang,
        ignoreIllegals: true,
        theme: getCodeHighlightTheme(),
      });
    }
    // 未指定语言时尝试自动检测
    return cliHighlight(code, {
      ignoreIllegals: true,
      theme: getCodeHighlightTheme(),
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
// 支持 SGR 转义码（\x1b[...m）和 OSC 8 超链接（\x1b]8;;...\x1b\\）
const ANSI_RE = /\x1b\[[\d;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

/**
 * CJK 感知的文本换行
 * - 按 \n 分割后逐字符遍历，用 stringWidth 累计宽度
 * - CJK 字符可在任意字符边界换行
 * - 正确跳过 ANSI 转义码（不计入宽度）
 * - 保护 OSC 8 超链接不被断开
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      result.push("");
      continue;
    }
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
      // 关键修复：检测 OSC 8 超链接，作为整体处理，不允许断开
      let line = "";
      let lineWidth = 0;
      let i = 0;

      while (i < paragraph.length) {
        // 检查是否是 OSC 8 超链接开始
        if (paragraph.slice(i, i + 3) === "\x1b]8") {
          // 查找完整的 OSC 8 超链接（从开始到结束）
          const linkStart = i;
          // 跳过 OSC 8 开始标记：\x1b]8;;....\x1b\\
          const startEnd = paragraph.indexOf("\x1b\\", i);
          if (startEnd === -1) {
            // 格式错误，跳过
            i++;
            continue;
          }

          // 跳过开始标记
          i = startEnd + 2;

          // 查找链接文本和结束标记
          const linkEnd = paragraph.indexOf("\x1b]8;;\x1b\\", i);
          if (linkEnd === -1) {
            // 格式错误，跳过
            continue;
          }

          // 提取完整的超链接（包括开始标记、文本、结束标记）
          const fullLink = paragraph.slice(linkStart, linkEnd + 7); // 7 = '\x1b]8;;\x1b\\'.length
          const linkText = paragraph.slice(i, linkEnd);
          const linkWidth = stringWidth(linkText);

          // 检查是否需要换行
          if (lineWidth + linkWidth > maxWidth && lineWidth > 0) {
            result.push(line);
            line = fullLink;
            lineWidth = linkWidth;
          } else {
            line += fullLink;
            lineWidth += linkWidth;
          }

          i = linkEnd + 7;
          continue;
        }

        // 尝试匹配其他 ANSI 转义码
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
  return left + colWidths.map((w) => "─".repeat(w + CELL_PADDING)).join(mid) + right;
}

/** 绘制内容行（支持多行 cell） */
function contentRows(cells: string[][], colWidths: number[], isBold: boolean): string[] {
  // cells[col] = wrapText 后的行数组
  const maxLines = Math.max(...cells.map((c) => c.length), 1);
  const lines: string[] = [];
  for (let l = 0; l < maxLines; l++) {
    const cellParts: string[] = [];
    for (let c = 0; c < colWidths.length; c++) {
      const text = cells[c]?.[l] || "";
      const display = isBold ? chalk.bold(text) : text;
      // 关键修复：先计算 padding，再拼接，确保右侧边框对齐
      const padded = padRight(display, colWidths[c]);
      cellParts.push(` ${padded} `);
    }
    lines.push("│" + cellParts.join("│") + "│");
  }
  return lines;
}

/** 用 box-drawing 字符绘制完整表格 */
function drawTable(
  headers: string[][], // headers[col] = wrapText 后的行数组
  rows: string[][][], // rows[row][col] = wrapText 后的行数组
  colWidths: number[], // 每列纯内容宽度
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
function renderTable(token: any, width: number): string {
  const headers: string[] = token.header.map((cell: any) =>
    cell.tokens ? renderInline(cell.tokens) : cell.text || "",
  );
  const rows: string[][] = token.rows.map((row: any[]) =>
    row.map((cell: any) => (cell.tokens ? renderInline(cell.tokens) : cell.text || "")),
  );
  const colCount = headers.length;
  const termWidth = width;

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
  const wrappedRows: string[][][] = rows.map((row) =>
    row.map((cell, i) => wrapText(cell, colWidths[i])),
  );

  return "\n" + drawTable(wrappedHeaders, wrappedRows, colWidths) + "\n";
}

/** key-value 竖排降级格式 */
function renderKeyValue(headers: string[], rows: string[][], termWidth: number): string {
  const separator = chalk.hex(theme.text.secondary)("─".repeat(Math.min(termWidth - 2, 40)));
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
    case 0:
      return `${num}.`;
    case 1:
      return `${toAlpha(num)}.`;
    case 2:
      return `${toRoman(num)}.`;
    default:
      return `${num}.`;
  }
}

// ── OSC 8 超链接 ────────────────────────────────────────────────

/** 渲染 OSC 8 终端超链接 */
function renderLink(label: string, href: string): string {
  // 使用主题配置的链接颜色，而不是 chalk 默认蓝色
  const styledLabel = chalk.hex(theme.text.link).underline(label);

  // 关键修复：仅在终端真正支持 OSC 8 超链接时才发送转义序列。
  // 此前用 process.stdout.isTTY 判断会误伤——很多 TTY 终端并不支持 OSC 8，
  // 会把裸露的转义码显示出来。改用 supportsHyperlinks() 做真实终端兼容检测
  // （覆盖 iTerm2/Kitty/Ghostty/alacritty/Hyper + tmux 透传等），
  // 不支持的终端降级为「颜色 + 下划线」纯文本。
  if (supportsHyperlinks()) {
    return `\x1b]8;;${href}\x1b\\${styledLabel}\x1b]8;;\x1b\\`;
  } else {
    return styledLabel;
  }
}

// ── 内联 token 递归渲染 ─────────────────────────────────────────

/** 递归渲染内联 token 数组为 ANSI 字符串 */
export function renderInline(tokens: any[]): string {
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
        // 用主题 AccentCyan hex 替代 ANSI 16 色 cyan（浅色终端下不可读）
        result += chalk.hex(themeManager.getActiveTheme().colors.AccentCyan)(token.text);
        break;
      case "del":
        result += chalk.hex(theme.text.secondary).strikethrough(renderInline(token.tokens));
        break;
      case "link":
        result += renderLink(token.tokens ? renderInline(token.tokens) : token.text, token.href);
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

/**
 * 将一段内联 markdown 文本（如表格单元格）渲染为 ANSI 字符串。
 * 走 marked 的 inline lexer + renderInline（标准 token），
 * 取代手写正则 parseMarkdownToANSI（P1-E）。
 *
 * defaultColor：整段文本的基础色（如表头用 theme.text.link）。仅对「未被
 * 内联样式包裹的裸文本」着色，已加粗/链接等片段保留自身样式。这里用 chalk
 * 对整段结果套一层基础色，chalk 会让内层已有的样式优先（嵌套 SGR）。
 */
export function renderInlineMarkdown(text: string, defaultColor?: string): string {
  if (!text) return "";
  try {
    configureMarked();
    const tokens = marked.Lexer.lexInline(text);
    const ansi = renderInline(tokens as any[]);
    if (!defaultColor) return ansi;
    if (defaultColor.startsWith("#")) {
      if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(defaultColor)) {
        return chalk.hex(defaultColor)(ansi);
      }
      return ansi;
    }
    const fn = (chalk as any)[defaultColor.toLowerCase()];
    return typeof fn === "function" ? fn(ansi) : ansi;
  } catch {
    return text;
  }
}

// ── 列表渲染 ────────────────────────────────────────────────────

/** 递归渲染列表（支持嵌套） */
function renderList(token: any, depth: number = 0): string {
  const indent = TAB_INDENT.repeat(depth);
  const lines: string[] = [];

  for (let i = 0; i < token.items.length; i++) {
    const item = token.items[i];
    const prefix = token.ordered ? `${formatOrderedPrefix((token.start || 1) + i, depth)} ` : "- ";

    // 收集当前列表项的内容。同一列表项可能有多个子块（松散列表的多段落、
    // 段落+代码块、段落+引用等，见 marked 对 "loose list" 的解析）。
    // 每个子块按自身的 "\n" 拆成行，并标记该行是否已自带完整缩进：
    // - 嵌套列表（type=list）递归产出的每一行已经是 "深一级 indent + 前缀 + 文本"，
    //   自身完整，不需要也不能再叠加悬挂缩进（否则会被重复缩进）。
    // - 其余子块（段落续行、代码块、引用等）的续行只带各自局部缩进（如代码块固定
    //   TAB_INDENT），还没对齐到"当前列表项文本"的起始列，需要补悬挂缩进。
    // "space" token（对应源码中的空行）不产生内容，只贡献一个空行占位，
    // 用来还原松散列表段落之间的空行间距。
    type ItemLine = { text: string; selfIndented: boolean };
    const itemLines: ItemLine[] = [];
    const pushBlock = (text: string, selfIndented: boolean) => {
      for (const line of text.split("\n")) itemLines.push({ text: line, selfIndented });
    };
    for (const child of item.tokens) {
      if (child.type === "text") {
        pushBlock(child.tokens ? renderInline(child.tokens) : child.text, false);
      } else if (child.type === "paragraph") {
        pushBlock(renderInline(child.tokens), false);
      } else if (child.type === "list") {
        pushBlock(renderList(child, depth + 1), true);
      } else if (child.type === "space") {
        itemLines.push({ text: "", selfIndented: true });
      } else {
        // 其他块级元素（代码块等）
        pushBlock(renderTokens([child]), false);
      }
    }

    // 悬挂缩进 = 当前层级缩进 + 前缀可见宽度，让续行对齐到列表项文本的起始列
    // （而不仅仅是列表符号那一列），提升可读性。
    const hangIndent = indent + " ".repeat(visibleWidth(prefix));
    itemLines.forEach((line, idx) => {
      if (idx === 0) {
        lines.push(`${indent}${prefix}${line.text}`);
      } else if (line.selfIndented || line.text === "") {
        lines.push(line.text);
      } else {
        lines.push(`${hangIndent}${line.text}`);
      }
    });
  }

  return lines.join("\n");
}

// ── 块级 token 渲染 ─────────────────────────────────────────────

/** 递归渲染块级 token 数组为 ANSI 字符串 */
export function renderTokens(tokens: any[], renderWidth?: number): string {
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
        const inner = renderTokens(token.tokens, renderWidth);
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
        blocks.push(renderTable(token, renderWidth ?? DEFAULT_TERM_WIDTH));
        break;
      }
      case "hr": {
        blocks.push("---");
        break;
      }
      case "html": {
        const trimmed = token.text.trim();
        if (trimmed) blocks.push(chalk.hex(theme.text.secondary)(trimmed));
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

/**
 * 渲染单个块级 token 为 ANSI 字符串（供 MarkdownAnsi 逐 token flush 非表格内容用）。
 * 表格 token 由调用方分流到 <TableRenderer>，不应进入此函数。
 */
export function formatTokenToAnsi(token: any, renderWidth?: number): string {
  return renderTokens([token], renderWidth);
}

/** 判断 token 是否为表格（MarkdownAnsi 据此分流到 React 表格组件） */
export function isTableToken(token: any): boolean {
  return token?.type === "table";
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

  // 关键修复：完全移除硬编码限制，使用动态计算
  // 当 maxWidth 明确指定时，直接使用 maxWidth
  // 否则使用终端实际宽度
  const effectiveWidth = maxWidth ?? w;

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

  try {
    log.debug(
      "UI:MD",
      `renderMarkdown 开始: textLen=${text.length} effectiveWidth=${effectiveWidth} textPreview=${JSON.stringify(text.slice(0, 100))}`,
    );
    const tokens = cachedLexer(text);
    log.debug(
      "UI:MD",
      `cachedLexer 完成: tokenCount=${tokens.length} tokenTypes=${tokens.map((t: any) => t.type).join(",")}`,
    );
    const result = renderTokens(tokens as any[], effectiveWidth).trimEnd();
    log.debug(
      "UI:MD",
      `renderTokens 完成: resultLen=${result.length} hasAnsi=${/\x1b\[/.test(result)} resultPreview=${JSON.stringify(result.slice(0, 100))}`,
    );

    if (renderCache.size >= MAX_CACHE_SIZE) {
      const firstKey = renderCache.keys().next().value;
      if (firstKey !== undefined) renderCache.delete(firstKey);
      log.debug("UI:MD", `缓存已满，淘汰最旧条目，当前 ${renderCache.size} 条`);
    }
    renderCache.set(cacheKey, result);

    return result;
  } catch (err: any) {
    log.error("UI:MD", `Markdown 渲染失败`, {
      error: err.message,
      stack: err.stack,
      textLen: text.length,
      textPreview: text.slice(0, 100),
    });
    return text;
  }
}

// ── 表格 token 数据提取（供 MarkdownAnsi 分流到 <TableRenderer>） ──
// 历史上这里还有一套 renderMarkdownToReact（逐行 <Text> 版），已无任何调用方，
// 与 MarkdownAnsi（marked AST + ANSI 整块）职责重复，整体删除（P2-G 收敛两套实现）。

/** 从 marked table token 提取 headers / rows 原始 markdown 文本 */
export function extractTableData(token: any): { headers: string[]; rows: string[][] } {
  const headers: string[] = (token.header ?? []).map((cell: any) => cell.text || "");
  const rows: string[][] = (token.rows ?? []).map((row: any[]) =>
    row.map((cell: any) => cell.text || ""),
  );
  return { headers, rows };
}
