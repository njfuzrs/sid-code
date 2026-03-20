/**
 * 用户消息组件
 *
 * 渲染用户输入的消息，带 "● 你" 前缀。
 * 参考 gemini-cli UserMessage.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../semantic-colors.ts";

interface UserMessageProps {
  text: string;
  width: number;
}

export const UserMessage: React.FC<UserMessageProps> = ({ text, width }) => {
  const prefix = "● ";
  const isSlashCommand = text.startsWith("/");
  const textColor = isSlashCommand ? theme.text.accent : theme.text.primary;

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.ui.active} bold>{prefix}你</Text>
      <Box paddingLeft={2}>
        <Text wrap="wrap" color={textColor}>{text}</Text>
      </Box>
    </Box>
  );
};
