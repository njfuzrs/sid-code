/**
 * 思考过程展示组件
 *
 * 渲染模型的思考过程，带左侧边框和斜体样式。
 * 参考 gemini-cli ThinkingMessage.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../semantic-colors.ts";

interface ThinkingMessageProps {
  text: string;
  width: number;
}

export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({ text, width }) => {
  if (!text.trim()) return null;

  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  return (
    <Box width={width} flexDirection="column">
      <Text color={theme.text.primary} italic>
        {" "}思考中...{" "}
      </Text>
      <Box
        marginLeft={1}
        paddingLeft={1}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={theme.text.secondary}
        flexDirection="column"
      >
        {lines.length > 0 && (
          <Text color={theme.text.primary} bold italic>
            {lines[0]}
          </Text>
        )}
        {lines.slice(1).map((line, index) => (
          <Text key={`thought-${index}`} color={theme.text.secondary} italic>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
