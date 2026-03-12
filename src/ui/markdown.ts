/**
 * Markdown 终端渲染
 * 使用 marked + marked-terminal 将 Markdown 渲染为终端格式
 */

import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

// 配置 marked 使用终端渲染器
marked.use(
  TerminalRenderer({
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 120),
    showSectionPrefix: false,
    tab: 2,
  }) as any,
);

/** 将 Markdown 文本渲染为终端格式 */
export function renderMarkdown(text: string): string {
  try {
    const rendered = marked.parse(text);
    if (typeof rendered === "string") {
      return rendered.trimEnd();
    }
    return text;
  } catch {
    return text;
  }
}
