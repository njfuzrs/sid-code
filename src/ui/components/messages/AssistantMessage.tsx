/**
 * 助手消息组件
 *
 * 渲染 AI 回复的文本内容，使用 MarkdownDisplay 组件。
 * 参考 gemini-cli GeminiMessage.tsx
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { MarkdownDisplay } from "../MarkdownDisplay.tsx";
import { theme } from "../../semantic-colors.ts";
import { useUIState } from "../../contexts/UIStateContext.tsx";

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
  const prefix = "✦ ";
  const prefixWidth = prefix.length;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={theme.text.accent}>{prefix}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MarkdownDisplay
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
