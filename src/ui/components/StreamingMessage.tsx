/**
 * 流式消息组件
 *
 * 显示正在生成的助手消息。
 * 直接将完整累积文本传给 renderMarkdownToReact() 渲染，
 * 不做 completed/pending 拆分（对齐 gemini-cli 方案）。
 */

import React, { useMemo } from "react";
import { Box } from "ink";
import { renderMarkdownToReact } from "../markdown.ts";
import { ASSISTANT_PADDING_RIGHT } from "../ui-utils.ts";

interface StreamingMessageProps {
  /** 累积的全部流式文本 */
  fullText: string;
  /** 渲染宽度 */
  maxWidth?: number;
}

export const StreamingMessage = React.memo(function StreamingMessage({
  fullText,
  maxWidth,
}: StreamingMessageProps) {
  if (!fullText) return null;

  const effectiveWidth = (maxWidth || 80) - ASSISTANT_PADDING_RIGHT;

  // 直接渲染完整文本，不做 completed/pending 拆分
  const rendered = useMemo(
    () => renderMarkdownToReact(fullText, effectiveWidth),
    [fullText, effectiveWidth],
  );

  return (
    <Box flexDirection="column" paddingRight={ASSISTANT_PADDING_RIGHT}>
      {rendered}
    </Box>
  );
});
