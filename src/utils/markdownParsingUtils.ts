/**
 * Markdown 内联解析工具（完全参考 gemini-cli）
 * 将 markdown 文本转换为 ANSI 字符串
 */

import chalk from "chalk";
import { theme } from "../ui/semantic-colors.ts";

// Markdown 标记长度常量
const BOLD_MARKER_LENGTH = 2; // "**"
const ITALIC_MARKER_LENGTH = 1; // "*" 或 "_"
const STRIKETHROUGH_MARKER_LENGTH = 2; // "~~"
const INLINE_CODE_MARKER_LENGTH = 1; // "`"
const UNDERLINE_TAG_START_LENGTH = 3; // "<u>"
const UNDERLINE_TAG_END_LENGTH = 4; // "</u>"

/**
 * 应用颜色到文本（使用 chalk ANSI 转义码）
 * 参考 gemini-cli 的 ansiColorize 实现
 */
function ansiColorize(str: string, color: string | undefined): string {
  if (!color) return str;

  // 支持 hex 颜色（#RRGGBB 或 #RGB）
  if (color.startsWith("#")) {
    // 验证 hex 格式
    if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(color)) {
      return chalk.hex(color)(str);
    }
    return str;
  }

  // 支持 chalk 内置颜色名
  const lowerColor = color.toLowerCase();
  const chalkColor = (chalk as any)[lowerColor];
  if (typeof chalkColor === "function") {
    return chalkColor(str);
  }

  // 不支持的颜色格式，返回原文本
  return str;
}

/**
 * 将 markdown 文本转换为 ANSI 字符串
 * 完全参考 gemini-cli 的实现
 * 支持：**加粗**、*斜体*、~~删除线~~、`行内代码`、[链接](url)、<u>下划线</u>
 */
export function parseMarkdownToANSI(
  text: string,
  defaultColor?: string,
): string {
  const baseColor = defaultColor ?? theme.text.primary;

  // 快速路径：纯文本无 markdown 标记
  if (!/[*_~`<[https?:]/.test(text)) {
    return ansiColorize(text, baseColor);
  }

  let result = "";
  const inlineRegex =
    /(\*\*\*.*?\*\*\*|\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g;
  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    // 添加匹配前的普通文本
    if (match.index > lastIndex) {
      result += ansiColorize(text.slice(lastIndex, match.index), baseColor);
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
          styledPart = ansiColorize(codeMatch[2], theme.text.accent);
        }
      }
      // [链接文本](url) - 参考 gemini-cli，显示完整格式
      else if (
        fullMatch.startsWith("[") &&
        fullMatch.includes("](") &&
        fullMatch.endsWith(")")
      ) {
        const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
        if (linkMatch) {
          const linkText = linkMatch[1];
          const url = linkMatch[2];
          // gemini-cli 的格式：链接文本 (url)
          styledPart =
            parseMarkdownToANSI(linkText, baseColor) +
            ansiColorize(" (", baseColor) +
            ansiColorize(url, theme.text.link) +
            ansiColorize(")", baseColor);
        }
      }
      // <u>下划线</u>
      else if (
        fullMatch.startsWith("<u>") &&
        fullMatch.endsWith("</u>") &&
        fullMatch.length > UNDERLINE_TAG_START_LENGTH + UNDERLINE_TAG_END_LENGTH - 1
      ) {
        styledPart = chalk.underline(
          parseMarkdownToANSI(
            fullMatch.slice(UNDERLINE_TAG_START_LENGTH, -UNDERLINE_TAG_END_LENGTH),
            baseColor,
          ),
        );
      }
      // 裸 URL
      else if (fullMatch.match(/^https?:\/\//)) {
        styledPart = ansiColorize(fullMatch, theme.text.link);
      }
    } catch (e) {
      // 解析失败，保留原文
      styledPart = "";
    }

    result += styledPart || ansiColorize(fullMatch, baseColor);
    lastIndex = inlineRegex.lastIndex;
  }

  // 添加剩余文本
  if (lastIndex < text.length) {
    result += ansiColorize(text.slice(lastIndex), baseColor);
  }

  return result;
}

/**
 * 移除不安全的控制字符
 *
 * 参考 gemini-cli textUtils.ts stripUnsafeCharacters()
 * 移除：C0 控制字符（保留 TAB/LF/CR）、C1 控制字符、BiDi 控制字符、零宽字符
 * 保留：所有可打印 Unicode（含 emoji）、ZWJ、ZWNJ
 */
export function stripUnsafeCharacters(str: string): string {
  // C0: 0x00-0x1F 除 0x09(TAB) 0x0A(LF) 0x0D(CR)
  // C1: 0x80-0x9F
  // BiDi: U+200E(LRM) U+200F(RLM) U+202A-U+202E U+2066-U+2069
  // Zero-width: U+200B(ZWSP) U+FEFF(BOM)
  // eslint-disable-next-line no-control-regex
  return str.replace(
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/g,
    "",
  );
}
