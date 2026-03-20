/**
 * 流式消息组件
 *
 * 显示正在生成的助手消息。
 * 已完成部分用 renderMarkdownToReact() 渲染并 memoize，
 * 未完成部分显示为 dimColor 文本 + 流式后缀。
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { renderMarkdownToReact } from "../markdown.ts";
import { findLastSafeSplitPoint, getStreamingSuffix } from "../markdown-utils.ts";
import { ASSISTANT_PADDING_RIGHT } from "../ui-utils.ts";

interface StreamingMessageProps {
  /** 累积的全部流式文本 */
  fullText: string;
  /** 是否正在活跃生成 */
  isActive: boolean;
  /** 渲染宽度 */
  maxWidth?: number;
}

export const StreamingMessage = React.memo(function StreamingMessage({
  fullText,
  isActive,
  maxWidth,
}: StreamingMessageProps) {
  if (!fullText) return null;

  const effectiveWidth = (maxWidth || 80) - ASSISTANT_PADDING_RIGHT;

  // 找到安全分割点：已完成部分可以安全渲染
  const splitPoint = useMemo(() => {
    if (!isActive) return fullText.length;
    return findLastSafeSplitPoint(fullText);
  }, [fullText, isActive]);

  // 已完成部分（memoize 渲染结果）
  const completedText = splitPoint > 0 ? fullText.slice(0, splitPoint).trimEnd() : "";
  const completedNode = useMemo(() => {
    if (!completedText) return null;
    return renderMarkdownToReact(completedText, effectiveWidth);
  }, [completedText, effectiveWidth]);

  // 未完成部分
  const pendingText = splitPoint > 0 ? fullText.slice(splitPoint) : fullText;
  const suffix = isActive ? getStreamingSuffix(fullText) : "";

  return (
    <Box flexDirection="column" paddingRight={ASSISTANT_PADDING_RIGHT}>
      {completedNode}
      {pendingText && (
        <Text dimColor>{pendingText}{suffix}</Text>
      )}
    </Box>
  );
});
