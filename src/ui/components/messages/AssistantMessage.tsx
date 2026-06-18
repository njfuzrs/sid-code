/**
 * 助手消息组件
 *
 * 渲染 AI 回复的文本内容，使用 MarkdownAnsi 组件。
 * 参考 gemini-cli GeminiMessage.tsx
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { MarkdownAnsi } from "../MarkdownAnsi.tsx";
import { theme } from "../../semantic-colors.ts";
import { useUIState } from "../../contexts/UIStateContext.tsx";
import { BULLET } from "../../constants/figures.ts";

interface AssistantMessageProps {
  text: string;
  width: number;
  isPending?: boolean;
  availableTerminalHeight?: number;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  text,
  width,
  isPending = false,
  availableTerminalHeight,
}) => {
  const { renderMarkdown } = useUIState();
  // ⏺ bullet 与工具行同构（品牌蓝），占位宽 2（glyph + 空格）
  const prefixWidth = 2;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={theme.ui.active}>{BULLET}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MarkdownAnsi
          text={text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeight === undefined
              ? undefined
              : Math.max(availableTerminalHeight - 1, 1)
          }
          terminalWidth={Math.max(width - prefixWidth, 0)}
          renderMarkdown={renderMarkdown}
        />
      </Box>
    </Box>
  );
};
