/**
 * 用户消息组件
 *
 * 渲染用户输入的消息，带 "> " 前缀。
 * 简洁风格：靠留白区隔，不用背景色盒子包裹（符合 L2.2）。
 */

import React from "react";
import Box from "../../../ink/components/Box.tsx";
import Text from "../../../ink/components/Text.tsx";
import { theme } from "../../semantic-colors.ts";
import { HalfLinePaddedBox } from "../shared/HalfLinePaddedBox.tsx";
import { stringWidth } from "../../../ink/stringWidth.ts";
import { USER_PROMPT } from "../../constants/figures.ts";

interface UserMessageProps {
  text: string;
  width: number;
  useBackgroundColor?: boolean;
}

export const UserMessage: React.FC<UserMessageProps> = ({
  text,
  width,
  useBackgroundColor = false,
}) => {
  const prefix = `${USER_PROMPT} `;
  const prefixWidth = stringWidth(prefix);
  const isSlashCommand = text.startsWith("/");
  const textColor = isSlashCommand ? theme.text.accent : theme.text.primary;

  return (
    <HalfLinePaddedBox
      backgroundBaseColor={theme.background.message}
      backgroundOpacity={1}
      useBackgroundColor={useBackgroundColor}
    >
      <Box
        flexDirection="row"
        paddingY={0}
        marginY={useBackgroundColor ? 0 : 1}
        paddingX={useBackgroundColor ? 1 : 0}
        alignSelf="flex-start"
        width={width}
      >
        <Box width={prefixWidth} flexShrink={0}>
          <Text color={theme.text.accent}>{prefix}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="wrap" color={textColor}>
            {text}
          </Text>
        </Box>
      </Box>
    </HalfLinePaddedBox>
  );
};
