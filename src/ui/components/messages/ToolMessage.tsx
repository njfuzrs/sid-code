/**
 * 单个工具消息组件
 *
 * 视觉语言对标 claude-code：去掉所有圆角边框盒子，改为
 *   ⏺ ToolName(参数摘要) — 结果摘要        ← 状态色 bullet + 工具信息
 *     ⎿ diff / 错误 / 进度                 ← 树枝缩进 2 空格
 *
 * 紧凑模式：成功结果只显示一行 header（name + description + 摘要）
 * 展开模式：错误 / diff / 进度 在树枝缩进区展开
 *
 * bash/shell 工具特殊处理：命令从 header 单行移到独立区域，以 wrap="wrap"
 * 自然换行展示完整命令，用户始终能看到 agent 在做什么。
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
  isShellTool,
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
  /** 工具执行耗时（毫秒），完成态时显示在工具名后。缺省时不显示 */
  elapsedMs?: number;
  /** bash/shell 工具的完整命令行文本（独立区域自然换行展示） */
  shellCommand?: string;
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
  elapsedMs,
  shellCommand,
}) => {
  const isShell = isShellTool(name);
  const hasShellCommand = isShell && !!shellCommand;

  // 有结果或进度就展开（结果默认通过 ToolResultDisplay 的 maxLines=3 折叠）
  const hasProgress = status === "executing" && progress !== undefined;
  const shouldExpandContent = !!resultDisplay || hasProgress;

  // Header 行：bash 工具不显示长命令（移到下方独立区域自然换行），header 保持简洁
  const header = (
    <Box width={terminalWidth} flexDirection="row">
      <ToolStatusIndicator status={status} />
      <ToolInfo
        name={name}
        description={hasShellCommand ? "" : description}
        status={status}
        emphasis={emphasis}
        progressMessage={progressMessage}
        resultSummary={shouldExpandContent ? undefined : resultSummary}
        elapsedMs={elapsedMs}
      />
      {emphasis === "high" && <TrailingIndicator />}
      <FocusHint name={name} status={status} />
    </Box>
  );

  // Shell 命令展示区域：完整命令，wrap="wrap" 自然换行，不截断
  // 2 空格缩进与 header 和结果区的视觉节奏一致
  const shellCommandSection = hasShellCommand ? (
    <Box flexDirection="row">
      <Box flexShrink={0} width={2}>
        <Text> </Text>
      </Box>
      <Box flexGrow={1}>
        <Text
          color={status === "executing" ? theme.text.primary : theme.text.secondary}
          wrap="wrap"
        >
          {`$ ${shellCommand}`}
        </Text>
      </Box>
    </Box>
  ) : null;

  // 无结果也无 shell 命令：紧凑模式只有 header
  if (!shouldExpandContent && !hasShellCommand) {
    return header;
  }

  // 展开模式：header + shell 命令（如有）+ 树枝缩进结果区（如有）
  return (
    <Box width={terminalWidth} flexDirection="column">
      {header}
      {shellCommandSection}
      {shouldExpandContent && (
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
              maxLines={3}
              overflowDirection="bottom"
            />
          </Box>
        </Box>
      )}
    </Box>
  );
};
