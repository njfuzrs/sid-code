/**
 * wrap-text 兼容层
 *
 * 原 ink@6.8.0 的 wrap-text.js 是 string-based 的文本换行/截断。
 * fork (@jrichman/ink@6.4.11) 用 StyledChar-based 的 text-wrap.ts 替代，
 * 签名完全不同，无法直接使用。
 *
 * 这里用 wrap-ansi + cli-truncate 风格实现一个 string-based 的兼容版本，
 * 供 Rasterizer 的 renderTextNode() 使用。
 */

import wrapAnsi from "wrap-ansi";
import cliTruncate from "cli-truncate";

/**
 * 对文本进行换行或截断处理
 *
 * @param text 输入文本（可能包含 ANSI 转义序列）
 * @param maxWidth 最大宽度（列数）
 * @param textWrap 换行模式：wrap / truncate / truncate-end / truncate-middle / truncate-start
 * @returns 处理后的文本
 */
export default function wrapText(
  text: string,
  maxWidth: number,
  textWrap?: string,
): string {
  if (!textWrap || textWrap === "wrap") {
    return wrapAnsi(text, maxWidth, { trim: false, hard: true });
  }

  if (textWrap.startsWith("truncate")) {
    // 根据截断模式选择 cli-truncate 的 position 参数
    let position: "start" | "middle" | "end" = "end";
    if (textWrap === "truncate-start") {
      position = "start";
    } else if (textWrap === "truncate-middle") {
      position = "middle";
    }

    const lines = text.split("\n");
    return lines
      .map((line) => cliTruncate(line, maxWidth, { position }))
      .join("\n");
  }

  return text;
}
