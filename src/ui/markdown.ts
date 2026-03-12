/**
 * Markdown 终端渲染
 * 使用 marked + marked-terminal 将 Markdown 渲染为终端格式
 */

import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// 配置 marked 使用终端渲染器
marked.use(
  markedTerminal({
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 120),
    showSectionPrefix: false,
    tab: 2,
  }) as any,
);

// 渲染缓存（避免重复渲染相同内容）
const renderCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

/** 将 Markdown 文本渲染为终端格式 */
export function renderMarkdown(text: string): string {
  // 检查缓存
  if (renderCache.has(text)) {
    return renderCache.get(text)!;
  }

  try {
    const rendered = marked.parse(text);
    const result = typeof rendered === "string" ? rendered.trimEnd() : text;

    // 添加到缓存（限制缓存大小）
    if (renderCache.size >= MAX_CACHE_SIZE) {
      const firstKey = renderCache.keys().next().value;
      renderCache.delete(firstKey);
    }
    renderCache.set(text, result);

    return result;
  } catch {
    return text;
  }
}
