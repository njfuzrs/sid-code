/**
 * 单个工具消息组件
 *
 * 渲染单个工具调用/结果，带状态指示器和描述。
 * 参考 gemini-cli ToolMessage.tsx
 *
 * P1 增强：
 * - 使用 StickyHeader 实现粘性头部
 * - 集成 ToolResultDisplay 统一结果渲染
 * - 支持 MCP 进度指示器（从 ToolShared 导入）
 * - TrailingIndicator 执行中箭头
 */

import React from "react";
import { Box } from "ink";
import {
  ToolStatusIndicator,
  ToolInfo,
  TrailingIndicator,
  McpProgressIndicator,
  FocusHint,
  type ToolCallStatus,
  type TextEmphasis,
} from "./ToolShared.tsx";
import { ToolResultDisplay } from "./ToolResultDisplay.tsx";
import { StickyHeader } from "../StickyHeader.tsx";

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
  /** 是否渲染输出为 Markdown */
  renderOutputAsMarkdown?: boolean;
  /** MCP 进度消息 */
  progressMessage?: string;
  /** MCP 进度值 */
  progress?: number;
  /** MCP 进度总量 */
  progressTotal?: number;
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
  renderOutputAsMarkdown = false,
  progressMessage,
  progress,
  progressTotal,
}) => {
  // 工具头部内容
  const headerContent = (
    <>
      <ToolStatusIndicator status={status} />
      <ToolInfo
        name={name}
        description={description}
        status={status}
        emphasis={emphasis}
        progressMessage={progressMessage}
      />
      {emphasis === "high" && <TrailingIndicator />}
      <FocusHint name={name} status={status} />
    </>
  );

  // 是否有内容需要渲染（结果或进度）
  const hasProgress = status === "executing" && progress !== undefined;
  const hasContent = !!resultDisplay || hasProgress;

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
      {hasContent && (
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
          {/* MCP 进度指示器 */}
          {hasProgress && (
            <McpProgressIndicator
              progress={progress!}
              total={progressTotal}
              message={progressMessage}
              barWidth={20}
            />
          )}
          {/* 工具结果 */}
          <ToolResultDisplay
            resultDisplay={resultDisplay}
            terminalWidth={terminalWidth - 4}
            isDiff={isDiff}
            filename={filename}
            isError={isError}
            renderOutputAsMarkdown={renderOutputAsMarkdown}
            maxLines={20}
            overflowDirection="top"
          />
        </Box>
      )}
    </>
  );
};
