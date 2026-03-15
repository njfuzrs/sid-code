/**
 * Markdown 终端渲染
 * 使用 marked + marked-terminal 将 Markdown 渲染为终端格式
 *
 * 支持的渲染效果：
 * - **加粗**、*斜体*、~~删除线~~、`行内代码`
 * - # 标题（一级紫色下划线加粗，二级+绿色加粗）
 * - > 引用（灰色斜体）
 * - 代码块语法高亮（cli-highlight，自动检测语言）
 * - 表格（cli-table3 box-drawing）
 * - 链接（蓝色 + 下划线 URL）
 * - 有序/无序列表
 * - 水平分割线
 * - :emoji: 表情符号
 */

import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight as cliHighlight, supportsLanguage } from "cli-highlight";
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

// 代码高亮 theme：使用我们的 chalk 实例，避免 marked-terminal 内部 bundle 的 chalk level=0 问题。
// Bun ESM 中 static import 在 process.env.FORCE_COLOR 赋值前加载，
// 导致 marked-terminal/cli-highlight 内部 bundle 的 chalk 检测不到颜色支持。
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

/** 代码块高亮，使用自定义 theme 绕过 bundle chalk level=0 */
function highlightCode(code: string, lang?: string): string {
  try {
    const opts: any = { ignoreIllegals: true, theme: codeHighlightTheme };
    if (lang && supportsLanguage(lang)) {
      opts.language = lang;
    }
    return cliHighlight(code, opts);
  } catch {
    return code;
  }
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

// 修复 marked-terminal v7 + marked v15 兼容性问题（两个 bug）：
//
// Bug 1 — 列表项内联格式不渲染：
//   marked-terminal 的 text renderer 收到 token 对象时只取 text.text（原始文本），
//   不调用 parseInline 解析内联 tokens，导致列表项内的 **加粗**、`代码`、*斜体* 等不渲染。
//
// Bug 2 — 代码块无语法高亮：
//   marked-terminal bundle 了自己的 chalk 实例，Bun ESM 中 static import 在
//   process.env.FORCE_COLOR 赋值前加载，导致内部 chalk.level=0，
//   highlight() 函数检测到 level=0 直接返回原文。
//   用自定义 code renderer + 我们的 chalk theme 绕过。
marked.use({
  renderer: {
    // 修复 text renderer：正确解析 inline tokens
    text(token: any): string {
      if (typeof token === "object" && token.tokens) {
        return (this as any).parser.parseInline(token.tokens);
      }
      return typeof token === "object" ? token.text : token;
    },
    // 修复 code renderer：使用自定义 theme 的代码高亮
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
      // 缩进 2 空格，前后加空行（与 marked-terminal 的 section 格式一致）
      const indented = highlighted
        .split("\n")
        .map((line: string) => "  " + line)
        .join("\n");
      return "\n" + indented + "\n";
    },
  },
} as any);

// 渲染缓存
const renderCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

/** 将 Markdown 文本渲染为终端格式 */
export function renderMarkdown(text: string): string {
  const termWidth = getTermWidth();
  const cacheKey = `${termWidth}:${text}`;

  if (renderCache.has(cacheKey)) {
    return renderCache.get(cacheKey)!;
  }

  const log = getLogger();

  try {
    const rendered = marked.parse(text);
    // marked-terminal 硬编码 BULLET_POINT = '* '，替换为 bullet 符号
    const result = typeof rendered === "string"
      ? rendered.trimEnd().replace(/^(\s*)\* /gm, "$1• ")
      : text;

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
