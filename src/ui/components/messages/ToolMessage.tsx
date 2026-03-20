/**
 * 单个工具消息组件
 *
 * 渲染单个工具调用/结果，带状态指示器和描述。
 * 参考 gemini-cli ToolMessage.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { ToolStatusIndicator, ToolInfo, type ToolCallStatus, type TextEmphasis } from "./ToolShared.tsx";
import { SlicingMaxSizedBox } from "../SlicingMaxSizedBox.tsx";
import { theme } from "../../semantic-colors.ts";

export interface ToolMessageProps {
  name: string;
  description: string;
  resultDisplay?: string;
  status: ToolCallStatus;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  isFirst: boolean;
  borderColor: string;
  borderDimColor: boolean;
  isError?: boolean;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  terminalWidth,
  emphasis = "medium",
  isFirst,
  borderColor,
  borderDimColor,
  isError,
}) => {
  const hasLongResult = resultDisplay && resultDisplay.length > 500 && !isError;

  return (
    <>
      {/* 工具头部：状态指示器 + 工具信息 */}
      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={borderColor}
        borderDimColor={borderDimColor}
        borderTop={isFirst}
        borderBottom={false}
        borderLeft={true}
        borderRight={true}
        paddingX={1}
      >
        <ToolStatusIndicator status={status} />
        <ToolInfo
          name={name}
          description={description}
          status={status}
          emphasis={emphasis}
        />
      </Box>

      {/* 工具结果内容 */}
      {resultDisplay && (
        <Box
          width={terminalWidth}
          borderStyle="round"
          borderColor={borderColor}
          borderDimColor={borderDimColor}
          borderTop={false}
          borderBottom={false}
          borderLeft={true}
          borderRight={true}
          paddingX={1}
          flexDirection="column"
        >
          {hasLongResult ? (
            <SlicingMaxSizedBox text={resultDisplay} maxLines={20} overflowDirection="top" />
          ) : (
            <Text color={isError ? theme.status.error : undefined} dimColor={!isError}>
              {resultDisplay}
            </Text>
          )}
        </Box>
      )}
    </>
  );
};
