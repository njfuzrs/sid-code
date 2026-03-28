/**
 * 单个工具消息组件
 *
 * 渲染单个工具调用/结果，带状态指示器和描述。
 * 参考 gemini-cli ToolMessage.tsx
 *
 * 紧凑模式：
 * - 成功结果只显示一行 header（name + description + 摘要）
 * - 错误结果展开显示错误信息
 * - diff 结果展开显示 diff
 * - 执行中显示进度
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

export interface ToolMessageProps {
  name: string;
  description: string;
  resultDisplay?: string;
  status: ToolCallStatus;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  isFirst: boolean;
  /** 是否为组内最后一个工具（控制底部边框） */
  isLast: boolean;
  borderColor: string;
  borderDimColor: boolean;
  isError?: boolean;
  isDiff?: boolean;
  filename?: string;
  renderOutputAsMarkdown?: boolean;
  progressMessage?: string;
  progress?: number;
  progressTotal?: number;
  resultSummary?: string;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  terminalWidth,
  emphasis = "medium",
  isFirst,
  isLast,
  borderColor,
  borderDimColor,
  isError,
  isDiff = false,
  filename,
  renderOutputAsMarkdown = false,
  progressMessage,
  progress,
  progressTotal,
  resultSummary,
}) => {
  const hasProgress = status === "executing" && progress !== undefined;
  const shouldExpandContent = (isError && !!resultDisplay) || (isDiff && !!resultDisplay) || hasProgress;

  // 紧凑模式（无展开内容）：header 自带底部边框
  if (!shouldExpandContent) {
    return (
      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={borderColor}
        borderDimColor={borderDimColor}
        borderTop={isFirst}
        borderBottom={isLast}
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
          progressMessage={progressMessage}
          resultSummary={resultSummary}
        />
        {emphasis === "high" && <TrailingIndicator />}
        <FocusHint name={name} status={status} />
      </Box>
    );
  }

  // 展开模式（错误/diff/进度）：header + 内容区
  return (
    <>
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
          progressMessage={progressMessage}
          resultSummary={resultSummary}
        />
        {emphasis === "high" && <TrailingIndicator />}
        <FocusHint name={name} status={status} />
      </Box>
      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={borderColor}
        borderDimColor={borderDimColor}
        borderTop={false}
        borderBottom={isLast}
        borderLeft={true}
        borderRight={true}
        paddingX={1}
        flexDirection="column"
      >
        {hasProgress && (
          <McpProgressIndicator
            progress={progress!}
            total={progressTotal}
            message={progressMessage}
            barWidth={20}
          />
        )}
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
    </>
  );
};
