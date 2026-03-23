/**
 * 单个工具消息组件
 *
 * 渲染单个工具调用/结果，带状态指示器和描述。
 * 参考 gemini-cli ToolMessage.tsx
 *
 * P1 增强：
 * - 使用 StickyHeader 实现粘性头部
 * - 支持 DiffRenderer 渲染 diff 内容
 */

import React from "react";
import { Box, Text } from "ink";
import { ToolStatusIndicator, ToolInfo, type ToolCallStatus, type TextEmphasis } from "./ToolShared.tsx";
import { SlicingMaxSizedBox } from "../SlicingMaxSizedBox.tsx";
import { StickyHeader } from "../StickyHeader.tsx";
import { DiffRenderer } from "../DiffRenderer.tsx";
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
  /** 是否为 diff 内容（用于 Edit 工具） */
  isDiff?: boolean;
  /** 文件名（用于 diff 语法高亮） */
  filename?: string;
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
  isDiff = false,
  filename,
}) => {
  const hasLongResult = resultDisplay && resultDisplay.length > 500 && !isError;

  // 工具头部内容
  const headerContent = (
    <>
      <ToolStatusIndicator status={status} />
      <ToolInfo
        name={name}
        description={description}
        status={status}
        emphasis={emphasis}
      />
    </>
  );

  return (
    <>
      {/* 工具头部：使用 StickyHeader 实现粘性效果 */}
      <StickyHeader
        width={terminalWidth}
        isFirst={isFirst}
        borderColor={borderColor}
        borderDimColor={borderDimColor}
      >
        {headerContent}
      </StickyHeader>

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
          {isDiff ? (
            // Diff 内容使用 DiffRenderer
            <DiffRenderer
              diffContent={resultDisplay}
              filename={filename}
              terminalWidth={terminalWidth - 2}
            />
          ) : hasLongResult ? (
            // 长文本使用 SlicingMaxSizedBox 截断
            <SlicingMaxSizedBox text={resultDisplay} maxLines={20} overflowDirection="top" />
          ) : (
            // 短文本直接显示
            <Text color={isError ? theme.status.error : undefined} dimColor={!isError}>
              {resultDisplay}
            </Text>
          )}
        </Box>
      )}
    </>
  );
};
