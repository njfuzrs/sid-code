/**
 * Markdown 终端渲染
 * 使用 marked + marked-terminal 将 Markdown 渲染为终端格式
 *
 * 支持的渲染效果：
 * - **加粗**、*斜体*、~~删除线~~、`行内代码`
 * - # 标题（一级紫色下划线加粗，二级+绿色加粗）
 * - > 引用（灰色斜体）
 * - 代码块语法高亮（cli-highlight，指定语言时启用）
 * - 表格（cli-table3 box-drawing）
 * - 链接（蓝色 + 下划线 URL）
 * - 有序/无序列表（• bullet）
 * - 水平分割线
 * - :emoji: 表情符号
 */

import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight as cliHighlight, supportsLanguage } from "cli-highlight";
import { getLogger } from "../debug/logger.ts";

// ── 常量 ────────────────────────────────────────────────────────
const DEFAULT_TERM_WIDTH = 80;
const MAX_RENDER_WIDTH = 120;
const TAB_SIZE = 2;
const TAB_INDENT = " ".repeat(TAB_SIZE);
const MAX_CACHE_SIZE = 100;
const BULLET = "• ";

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
// 使用我们的 chalk 实例构建 theme，绕过 marked-terminal/cli-highlight
// 内部 bundle 的 chalk level=0 问题（Bun ESM static import 时序）。
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

// ── marked-terminal 配置 ────────────────────────────────────────
// 封装为函数，终端宽度变化时重新配置，确保 reflowText 跟随实际宽度。
function configureMarked(): void {
  const width = Math.min(getTermWidth(), MAX_RENDER_WIDTH);

  marked.setOptions({});
  marked.use(
    markedTerminal(
      {
        // 样式
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
        // 格式
        reflowText: true,
        width,
        showSectionPrefix: false,
        tab: TAB_SIZE,
        unescape: true,
        emoji: true,
      },
      { ignoreIllegals: true },
    ) as any,
  );

  // 修复 marked-terminal v7 + marked v15 兼容性问题：
  //
  // Bug 1 — 列表项内联格式不渲染：
  //   text renderer 只取 text.text 原始字符串，不解析 inline tokens。
  //
  // Bug 2 — 代码块无语法高亮：
  //   内部 bundle 的 chalk level=0，highlight() 直接返回原文。
  //   用自定义 code renderer + 我们的 chalk theme 绕过。
  marked.use({
    renderer: {
      text(token: any): string {
        if (typeof token === "object" && token.tokens) {
          return (this as any).parser.parseInline(token.tokens);
        }
        return typeof token === "object" ? token.text : token;
      },
      code(token: any): string {
        let code: string;
        let lang: string | undefined;
        if (typeof token === "object") {
          code = token.text;
          lang = token.lang;
        } else {
          code = token;
        }
        const highlighted = highlightCode(code, lang);
        const indented = highlighted
          .split("\n")
          .map((line: string) => TAB_INDENT + line)
          .join("\n");
        return "\n" + indented + "\n";
      },
    },
  } as any);
}

// 记录上次配置时的终端宽度，宽度变化时重新配置并清空缓存
let lastConfiguredWidth = 0;

function ensureConfigured(): void {
  const w = getTermWidth();
  if (w !== lastConfiguredWidth) {
    configureMarked();
    lastConfiguredWidth = w;
    renderCache.clear();
  }
}

// ── 渲染缓存 ────────────────────────────────────────────────────
const renderCache = new Map<string, string>();

/** 将 Markdown 文本渲染为终端格式 */
export function renderMarkdown(text: string): string {
  ensureConfigured();

  if (renderCache.has(text)) {
    return renderCache.get(text)!;
  }

  const log = getLogger();

  try {
    // marked v17: 明确 async: false 确保返回 string（不是 Promise）
    const rendered = marked.parse(text, { async: false });
    // marked-terminal 硬编码 BULLET_POINT = '* '，替换为 • 符号。
    // 列表 bullet 后紧跟 ANSI 码（chalk.reset 的 \x1b[），以此区分代码块中的 '* '。
    const result = rendered.trimEnd().replace(/^(\s*)\* (\x1b\[)/gm, `$1${BULLET}$2`);

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
