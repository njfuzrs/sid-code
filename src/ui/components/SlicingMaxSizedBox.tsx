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

export const SlicingMaxSizedBox = React.memo(function SlicingMaxSizedBox({
  maxChars = 20000,
  maxLines,
  overflowDirection = "top",
  text,
}: SlicingMaxSizedBoxProps) {
  let lines = text.split("\n");
  let hiddenCount = 0;
  let truncated = false;

  // 字符级截断
  if (text.length > maxChars) {
    truncated = true;
    if (overflowDirection === "top") {
      const truncatedText = text.slice(-maxChars);
      lines = truncatedText.split("\n");
    } else {
      const truncatedText = text.slice(0, maxChars);
      lines = truncatedText.split("\n");
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
    // 字符截断但没有行截断时，估算隐藏行数
    const originalLines = text.split("\n").length;
    hiddenCount = Math.max(0, originalLines - lines.length);
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
