/**
 * 错误消息组件
 *
 * 视觉语言：左侧一条红色竖线引导（呼应 ThinkingMessage 的竖线语言），
 * 行首 ✘ 统一字形 + "错误" 标签，正文柔和不刺眼。多行错误按行保留结构。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";
import { ERROR_MARK } from "../../constants/figures.ts";

interface ErrorMessageProps {
  text: string;
  width: number;
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ text, width }) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const bodyWidth = Math.max(1, width - 1);

  return (
    <Box width={width} flexDirection="column">
      {/* 标题行：统一 ✘ 字形 + 标签，与 ⏺ bullet 同列对齐 */}
      <Box>
        <Text color={theme.status.error} bold>{`${ERROR_MARK} `}</Text>
        <Text color={theme.status.error}>错误</Text>
      </Box>

      {/* 正文：左侧红色竖线引导，错误文本用柔和的主文本色而非刺眼纯红 */}
      <Box
        marginLeft={1}
        paddingLeft={1}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={theme.status.error}
        flexDirection="column"
        width={bodyWidth}
      >
        {lines.map((line, index) => (
          <Text key={`err-${index}`} color={theme.text.primary} wrap="wrap">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
