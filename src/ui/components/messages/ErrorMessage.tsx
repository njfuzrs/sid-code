/**
 * 错误消息组件
 *
 * 渲染错误信息，带红色图标。
 * 参考 gemini-cli ErrorMessage.tsx
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";

interface ErrorMessageProps {
  text: string;
  width: number;
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ text, width }) => {
  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text color={theme.status.error} bold>{"✗ "}</Text>
        <Text color={theme.status.error}>{text}</Text>
      </Box>
    </Box>
  );
};
