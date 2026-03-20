/**
 * 内容截断组件
 *
 * 当子内容超过 maxChars 或 maxLines 时，截断并显示隐藏行数提示。
 */

import React from "react";
import { Box, Text } from "ink";

interface SlicingMaxSizedBoxProps {
  /** 最大字符数 */
  maxChars?: number;
  /** 最大行数 */
  maxLines?: number;
  /** 截断方向：top 保留底部，bottom 保留顶部 */
  overflowDirection?: "top" | "bottom";
  /** 文本内容 */
  text: string;
}

/** 按码点安全切割字符串，避免切断 UTF-16 代理对（emoji/CJK 扩展字符） */
function safeSlice(text: string, start: number, end?: number): string {
  const codePoints = Array.from(text);
  return codePoints.slice(start, end).join("");
}

/** 统计字符串中的换行数（不需要 split 创建数组） */
function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

export const SlicingMaxSizedBox = React.memo(function SlicingMaxSizedBox({
  maxChars = 20000,
  maxLines,
  overflowDirection = "top",
  text,
}: SlicingMaxSizedBoxProps) {
  // 预先计算原始行数（只遍历一次）
  const originalLineCount = countNewlines(text) + 1;
  let lines = text.split("\n");
  let hiddenCount = 0;
  let truncated = false;

  // 字符级截断（按码点安全切割）
  const codePointLength = Array.from(text).length;
  if (codePointLength > maxChars) {
    truncated = true;
    if (overflowDirection === "top") {
      lines = safeSlice(text, codePointLength - maxChars).split("\n");
    } else {
      lines = safeSlice(text, 0, maxChars).split("\n");
    }
  }

  // 行级截断
  if (maxLines && lines.length > maxLines) {
    truncated = true;
    hiddenCount = lines.length - maxLines;
    if (overflowDirection === "top") {
      lines = lines.slice(-maxLines);
    } else {
      lines = lines.slice(0, maxLines);
    }
  }

  if (!truncated) {
    hiddenCount = 0;
  } else if (hiddenCount === 0) {
    // 字符截断但没有行截断时，用预计算的原始行数
    hiddenCount = Math.max(0, originalLineCount - lines.length);
  }

  const indicator = hiddenCount > 0
    ? <Text dimColor color="yellow">{`... ${hiddenCount} 行已隐藏 ...`}</Text>
    : null;

  return (
    <Box flexDirection="column">
      {truncated && overflowDirection === "top" && indicator}
      <Text>{lines.join("\n")}</Text>
      {truncated && overflowDirection === "bottom" && indicator}
    </Box>
  );
});
