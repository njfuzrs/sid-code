/**
 * 内容截断组件
 *
 * 当子内容超过 maxChars 或 maxLines 时，截断并显示隐藏行数提示。
 *
 * 对标 claude-code 的 renderTruncatedContent（utils/terminal.ts）：
 * - maxColumnWidth 开启宽度感知换行：长行先按终端列宽折叠，再按 maxLines 截断。
 *   这样“3 行”是 3 个视觉行，而非 3 个原始行（其中一条可能 500 字符占满屏幕）。
 * - 当仅剩 1 行未显示时，直接展示该行（不显示 “… +1 行” 占位）。
 */

import React from "react";
import stringWidth from "string-width";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { formatCollapsedSummary } from "../constants/collapse.ts";

interface SlicingMaxSizedBoxProps {
  /** 最大字符数 */
  maxChars?: number;
  /** 最大行数（视觉行数，启用 maxColumnWidth 后以折叠后的行为准） */
  maxLines?: number;
  /** 截断方向：top 保留底部，bottom 保留顶部 */
  overflowDirection?: "top" | "bottom";
  /** 文本内容 */
  text: string;
  /**
   * 终端列宽上限（视觉列，非码点）。
   * 提供后启用宽度感知换行：长行会按此宽度折叠为多个视觉行，再按 maxLines 截断。
   * 对标 claude-code: MAX_LINES_TO_SHOW=3 + wrapWidth 感知。
   */
  maxColumnWidth?: number;
  /** 正文颜色（走 theme.* 语义 token，不传则用终端默认色）。 */
  color?: string;
  /** 是否暗淡正文（stdout 等次要输出）。 */
  dimColor?: boolean;
}

/** 统计字符串中的换行数（不需要 split 创建数组） */
function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * 宽度感知换行：把每行按 maxColumnWidth 折叠为多个视觉行。
 * 对标 claude-code utils/terminal.ts 的 wrapText。
 * 仅在提供 maxColumnWidth 时调用。
 */
function wrapLinesToWidth(
  text: string,
  maxColumnWidth: number,
): string[] {
  const rawLines = text.split("\n");
  const wrappedLines: string[] = [];

  for (const raw of rawLines) {
    const trimmed = raw.trimEnd();
    const w = stringWidth(trimmed);
    if (w <= maxColumnWidth) {
      wrappedLines.push(trimmed);
    } else {
      // 长行按 maxColumnWidth 切段（简单码点切割，工具输出以 ASCII 为主）
      let pos = 0;
      while (pos < w) {
        const chunk = trimmed.slice(pos, pos + maxColumnWidth);
        wrappedLines.push(chunk.trimEnd());
        pos += maxColumnWidth;
      }
    }
  }

  return wrappedLines;
}

export const SlicingMaxSizedBox = React.memo(function SlicingMaxSizedBox({
  maxChars = 20000,
  maxLines,
  overflowDirection = "top",
  text,
  maxColumnWidth,
  color,
  dimColor,
}: SlicingMaxSizedBoxProps) {
  let displayText = text;
  let hiddenCount = 0;
  let truncated = false;

  // 字符级截断（快速路径：ASCII 文本 text.length === 码点数，可跳过 Array.from）
  if (text.length > maxChars) {
    // 可能需要码点安全切割（只在超限时才创建 code points 数组）
    const codePoints = Array.from(text);
    const codePointLength = codePoints.length;
    if (codePointLength > maxChars) {
      truncated = true;
      if (overflowDirection === "top") {
        displayText = codePoints.slice(codePointLength - maxChars).join("");
      } else {
        displayText = codePoints.slice(0, maxChars).join("");
      }
    }
  }

  // 宽度感知换行（对标 claude-code）：先折叠长行，再按视觉行截断
  if (maxColumnWidth && maxColumnWidth > 0) {
    const wrappedLines = wrapLinesToWidth(displayText, maxColumnWidth);

    if (maxLines && wrappedLines.length > maxLines) {
      // 对标 cc: 若仅剩 1 行则直接展示，不占位
      const remaining = wrappedLines.length - maxLines;
      if (remaining === 1) {
        // 展示 maxLines + 1 行，hiddenCount = 0
        displayText = wrappedLines.slice(0, maxLines + 1).join("\n");
        truncated = false;
        hiddenCount = 0;
      } else {
        truncated = true;
        hiddenCount = remaining;
        if (overflowDirection === "top") {
          displayText = wrappedLines.slice(-maxLines).join("\n");
        } else {
          displayText = wrappedLines.slice(0, maxLines).join("\n");
        }
      }
    } else {
      displayText = wrappedLines.join("\n");
    }
  } else {
    // 无宽度感知：传统按 \n 行数截断
    const originalLineCount = countNewlines(displayText) + 1;
    let lines = displayText.split("\n");
    if (maxLines && lines.length > maxLines) {
      truncated = true;
      hiddenCount = lines.length - maxLines;
      if (overflowDirection === "top") {
        lines = lines.slice(-maxLines);
      } else {
        lines = lines.slice(0, maxLines);
      }
    } else if (truncated) {
      // 字符截断但没有行截断时，用原始行数估算
      hiddenCount = Math.max(0, originalLineCount - lines.length);
    }
    displayText = lines.join("\n");
  }

  if (!truncated) {
    hiddenCount = 0;
  }

  const lines = displayText.split("\n");
  const indicator = hiddenCount > 0
    ? <Text dimColor color={theme.status.warning}>{formatCollapsedSummary(hiddenCount, { hint: "ctrl+o" })}</Text>
    : null;

  return (
    <Box flexDirection="column">
      {truncated && overflowDirection === "top" && indicator}
      {lines.map((line, idx) => (
        <Text key={idx} color={color} dimColor={dimColor}>{line}</Text>
      ))}
      {truncated && overflowDirection === "bottom" && indicator}
    </Box>
  );
});
