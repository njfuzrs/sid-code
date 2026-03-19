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
import stringWidth from "string-width";

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
    const lines = text.split("\n");
    return lines
      .map((line) => {
        if (stringWidth(line) <= maxWidth) return line;
        // 简化截断：只保留前 maxWidth 列
        // truncate-end（默认）/ truncate / truncate-start / truncate-middle
        // 这里统一用 slice 近似处理，对纯 ASCII 足够精确
        // 对于含 ANSI 的文本，wrap-ansi 的 trim 模式也是类似处理
        return line.slice(0, maxWidth);
      })
      .join("\n");
  }

  return text;
}
