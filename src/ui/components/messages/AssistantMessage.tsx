/**
 * 助手消息组件
 *
 * 渲染 AI 回复的文本内容，使用 Markdown 渲染。
 * 参考 gemini-cli GeminiMessage.tsx
 */

import React from "react";
import { Box } from "ink";
import { renderMarkdownToReact } from "../../markdown.ts";
import { ASSISTANT_PADDING_RIGHT } from "../../ui-utils.ts";

interface AssistantMessageProps {
  text: string;
  width: number;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ text, width }) => {
  const contentWidth = width - ASSISTANT_PADDING_RIGHT;

  return (
    <Box flexDirection="column" paddingRight={ASSISTANT_PADDING_RIGHT}>
      {renderMarkdownToReact(text, contentWidth)}
    </Box>
  );
};
