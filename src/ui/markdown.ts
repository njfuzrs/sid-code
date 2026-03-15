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
    const result = typeof rendered === "string" ? rendered.trimEnd() : text;

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
