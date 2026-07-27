/**
 * T-3.11「复制整页」的数据准备 —— 单独成模块以便单测（config.ts 本身不便被测试 import）。
 *
 * 复制的是**原始 markdown 源文**，不是渲染后的 HTML/innerText：用户复制整页的真实
 * 目的是贴给 agent（§4.2.4），markdown 才是 agent 友好的形态——表格结构完整、
 * 无样式噪音、代码块边界清晰。
 */

/**
 * 去掉 markdown 的 frontmatter 块，只留正文。
 * frontmatter 是给构建器看的元数据（title/description/lastReviewed），贴给 agent 属噪音。
 *
 * 刻意只剥「文件开头」的那一段：正文里的 `---`（水平线、表格分隔）不能被当成 frontmatter 边界。
 */
export function stripFrontmatter(src: string): string {
  if (!src.startsWith("---")) return src;
  // 找关闭分隔符：必须是独占一行的 ---
  const close = src.indexOf("\n---", 3);
  if (close < 0) return src; // 没有闭合 → 那不是 frontmatter，原样返回
  const lineEnd = src.indexOf("\n", close + 1);
  if (lineEnd < 0) return "";
  return src.slice(lineEnd + 1).replace(/^\n+/, "");
}
