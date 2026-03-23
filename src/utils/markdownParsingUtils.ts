/**
 * Markdown 内联解析工具（参考 gemini-cli）
 * 将 markdown 文本转换为 ANSI 字符串
 */

import chalk from "chalk";
import { theme } from "../ui/semantic-colors.ts";

// Markdown 标记长度常量
const BOLD_MARKER_LENGTH = 2; // "**"
const ITALIC_MARKER_LENGTH = 1; // "*" 或 "_"
const STRIKETHROUGH_MARKER_LENGTH = 2; // "~~"
const INLINE_CODE_MARKER_LENGTH = 1; // "`"

/**
 * 将 markdown 文本转换为 ANSI 字符串
 * 支持：**加粗**、*斜体*、~~删除线~~、`行内代码`、[链接](url)
 */
export function parseMarkdownToANSI(
  text: string,
  defaultColor?: string,
): string {
  const baseColor = defaultColor ?? theme.text.primary;

  // 快速路径：纯文本无 markdown 标记
  if (!/[*_~`<[https?:]/.test(text)) {
    return colorize(text, baseColor);
  }

  let result = "";
  const inlineRegex =
    /(\*\*\*.*?\*\*\*|\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|https?:\/\/\S+)/g;
  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    // 添加匹配前的普通文本
    if (match.index > lastIndex) {
      result += colorize(text.slice(lastIndex, match.index), baseColor);
    }

    const fullMatch = match[0];
    let styledPart = "";

    try {
      // ***加粗斜体***
      if (
        fullMatch.endsWith("***") &&
        fullMatch.startsWith("***") &&
        fullMatch.length > (BOLD_MARKER_LENGTH + ITALIC_MARKER_LENGTH) * 2
      ) {
        styledPart = chalk.bold(
          chalk.italic(
            parseMarkdownToANSI(
              fullMatch.slice(
                BOLD_MARKER_LENGTH + ITALIC_MARKER_LENGTH,
                -BOLD_MARKER_LENGTH - ITALIC_MARKER_LENGTH,
              ),
              baseColor,
            ),
          ),
        );
      }
      // **加粗**
      else if (
        fullMatch.endsWith("**") &&
        fullMatch.startsWith("**") &&
        fullMatch.length > BOLD_MARKER_LENGTH * 2
      ) {
        styledPart = chalk.bold(
          parseMarkdownToANSI(
            fullMatch.slice(BOLD_MARKER_LENGTH, -BOLD_MARKER_LENGTH),
            baseColor,
          ),
        );
      }
      // *斜体* 或 _斜体_
      else if (
        fullMatch.length > ITALIC_MARKER_LENGTH * 2 &&
        ((fullMatch.startsWith("*") && fullMatch.endsWith("*")) ||
          (fullMatch.startsWith("_") && fullMatch.endsWith("_"))) &&
        !/\w/.test(text.substring(match.index - 1, match.index)) &&
        !/\w/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 1)) &&
        !/\S[./\\]/.test(text.substring(match.index - 2, match.index)) &&
        !/[./\\]\S/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 2))
      ) {
        styledPart = chalk.italic(
          parseMarkdownToANSI(
            fullMatch.slice(ITALIC_MARKER_LENGTH, -ITALIC_MARKER_LENGTH),
            baseColor,
          ),
        );
      }
      // ~~删除线~~
      else if (
        fullMatch.startsWith("~~") &&
        fullMatch.endsWith("~~") &&
        fullMatch.length > STRIKETHROUGH_MARKER_LENGTH * 2
      ) {
        styledPart = chalk.strikethrough(
          parseMarkdownToANSI(
            fullMatch.slice(STRIKETHROUGH_MARKER_LENGTH, -STRIKETHROUGH_MARKER_LENGTH),
            baseColor,
          ),
        );
      }
      // `行内代码`
      else if (
        fullMatch.startsWith("`") &&
        fullMatch.endsWith("`") &&
        fullMatch.length > INLINE_CODE_MARKER_LENGTH
      ) {
        const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
        if (codeMatch && codeMatch[2]) {
          styledPart = colorize(codeMatch[2], theme.text.accent);
        }
      }
      // [链接文本](url)
      else if (
        fullMatch.startsWith("[") &&
        fullMatch.includes("](") &&
        fullMatch.endsWith(")")
      ) {
        const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
        if (linkMatch) {
          const linkText = linkMatch[1];
          // 只显示链接文本，不显示 URL（避免表格中链接过长导致换行问题）
          styledPart = colorize(linkText, theme.text.link);
        }
      }
      // 裸 URL
      else if (fullMatch.match(/^https?:\/\//)) {
        styledPart = colorize(fullMatch, theme.text.link);
      }
    } catch (e) {
      // 解析失败，保留原文
      styledPart = "";
    }

    result += styledPart || colorize(fullMatch, baseColor);
    lastIndex = inlineRegex.lastIndex;
  }

  // 添加剩余文本
  if (lastIndex < text.length) {
    result += colorize(text.slice(lastIndex), baseColor);
  }

  return result;
}

/** 应用颜色到文本（使用 chalk ANSI 转义码） */
function colorize(str: string, color: string | undefined): string {
  if (!color) return str;

  // 支持 hex 颜色（#RRGGBB 或 #RGB）
  if (color.startsWith("#")) {
    // 验证 hex 格式
    if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(color)) {
      return chalk.hex(color)(str);
    }
    return str;
  }

  // 支持 chalk 内置颜色名（black, red, green, yellow, blue, magenta, cyan, white, gray）
  const lowerColor = color.toLowerCase();
  const chalkColor = (chalk as any)[lowerColor];
  if (typeof chalkColor === "function") {
    return chalkColor(str);
  }

  // 不支持的颜色格式，返回原文本
  return str;
}
