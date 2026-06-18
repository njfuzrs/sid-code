/**
 * 流式消息组件
 *
 * 显示正在生成的助手消息。内部走 StreamingMarkdown（marked AST + ANSI 整块），
 * 取代旧的逐行 MarkdownDisplay。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { StreamingMarkdown } from "./StreamingMarkdown.tsx";
import { theme } from "../semantic-colors.ts";
import { BULLET } from "../constants/figures.ts";

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

  // ⏺ bullet 与静态 AssistantMessage 同构（品牌蓝），占位宽 2
  const prefixWidth = 2;
  const terminalWidth = maxWidth || 80;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={theme.ui.active}>{BULLET}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <StreamingMarkdown
          text={fullText}
          availableTerminalHeight={
            availableTerminalHeight === undefined
              ? undefined
              : Math.max(availableTerminalHeight - 1, 1)
          }
          terminalWidth={Math.max(terminalWidth - prefixWidth, 0)}
        />
      </Box>
    </Box>
  );
});
