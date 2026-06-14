/**
 * 单个工具消息组件
 *
 * 视觉语言对标 claude-code：去掉所有圆角边框盒子，改为
 *   ⏺ ToolName(参数摘要) — 结果摘要        ← 状态色 bullet + 工具信息
 *     ⎿ diff / 错误 / 进度                 ← 树枝缩进 2 空格
 *
 * 紧凑模式：成功结果只显示一行 header（name + description + 摘要）
 * 展开模式：错误 / diff / 进度 在树枝缩进区展开
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
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
import { theme } from "../../semantic-colors.ts";
import { TREE_BRANCH } from "../../constants/figures.ts";

export interface ToolMessageProps {
  name: string;
  description: string;
  resultDisplay?: string;
  status: ToolCallStatus;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  isFirst: boolean;
  /** @deprecated 去盒子后不再控制底部边框，保留以兼容调用方 */
  isLast?: boolean;
  isError?: boolean;
  isDiff?: boolean;
  filename?: string;
  /** 结构化 diff(edit/write):优先于 resultDisplay 文本渲染 */
  structuredPatch?: import("diff").StructuredPatchHunk[];
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
  isError,
  isDiff = false,
  filename,
  structuredPatch,
  renderOutputAsMarkdown = false,
  progressMessage,
  progress,
  progressTotal,
  resultSummary,
}) => {
  const hasProgress = status === "executing" && progress !== undefined;
  const hasPatch = !!structuredPatch?.length;
  // 有结构化 diff 时即使 resultDisplay 仅为摘要也展开(diff 由 patch 独立渲染)
  const shouldExpandContent = (isError && !!resultDisplay) || (isDiff && (hasPatch || !!resultDisplay)) || hasProgress;

  // Header 行：⏺ bullet + 工具信息（无边框）。
  // 展开模式下结果已在下方树枝区呈现，header 不再重复 resultSummary 避免冗余。
  const header = (
    <Box width={terminalWidth} flexDirection="row">
      <ToolStatusIndicator status={status} />
      <ToolInfo
        name={name}
        description={description}
        status={status}
        emphasis={emphasis}
        progressMessage={progressMessage}
        resultSummary={shouldExpandContent ? undefined : resultSummary}
      />
      {emphasis === "high" && <TrailingIndicator />}
      <FocusHint name={name} status={status} />
    </Box>
  );

  // 紧凑模式：只有 header
  if (!shouldExpandContent) {
    return header;
  }

  // 展开模式：header + 树枝缩进结果区（无边框）
  return (
    <Box width={terminalWidth} flexDirection="column">
      {header}
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={theme.text.secondary} dimColor>{`  ${TREE_BRANCH} `}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
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
            terminalWidth={Math.max(1, terminalWidth - 4)}
            isDiff={isDiff}
            filename={filename}
            structuredPatch={structuredPatch}
            isError={isError}
            renderOutputAsMarkdown={renderOutputAsMarkdown}
            maxLines={20}
            overflowDirection="top"
          />
        </Box>
      </Box>
    </Box>
  );
};
