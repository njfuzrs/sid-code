/**
 * 流式消息组件
 *
 * 显示正在生成的助手消息，使用 MarkdownDisplay 支持流式截断。
 * 参考 gemini-cli 方案。
 */

import React from "react";
import { Box, Text } from "ink";
import { MarkdownDisplay } from "./MarkdownDisplay.tsx";
import { theme } from "../semantic-colors.ts";

interface StreamingMessageProps {
  /** 累积的全部流式文本 */
  fullText: string;
  /** 渲染宽度 */
  maxWidth?: number;
  /** 可用终端高度（用于流式截断） */
  availableTerminalHeight?: number;
}

export const StreamingMessage = React.memo(function StreamingMessage({
  fullText,
  maxWidth,
  availableTerminalHeight,
}: StreamingMessageProps) {
  if (!fullText) return null;

  const prefix = "✦ ";
  const prefixWidth = prefix.length;
  const terminalWidth = maxWidth || 80;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={theme.text.accent}>{prefix}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MarkdownDisplay
          text={fullText}
          isPending={true}
          availableTerminalHeight={
            availableTerminalHeight === undefined
              ? undefined
              : Math.max(availableTerminalHeight - 1, 1)
          }
          terminalWidth={Math.max(terminalWidth - prefixWidth, 0)}
          renderMarkdown={true}
        />
      </Box>
    </Box>
  );
});
