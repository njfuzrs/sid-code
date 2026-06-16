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
 * bash/shell 工具特殊处理：命令从 header 单行移到独立区域展示。
 * 对标 cc BashTool/UI.tsx，默认截断到 2 行 / 160 字符，ctrl+o 展开完整命令。
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
import { useUIState } from "../../contexts/UIStateContext.tsx";
import { formatCollapsedSummary, ELLIPSIS } from "../../constants/collapse.ts";

// 命令截断常量（对标 cc BashTool/UI.tsx: MAX_COMMAND_DISPLAY_LINES=2, MAX_COMMAND_DISPLAY_CHARS=160）
const CMD_MAX_LINES = 2;
const CMD_MAX_CHARS = 160;

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
  const { expandLevel } = useUIState();
  // 展开级别：0=折叠 1=更多 2=全展开。level >= 1 时命令不再截断，
  // 让用户按一次 ctrl+o 即可看到完整命令（对标 cc 的阶梯展开直觉）。
  const isFullyExpanded = expandLevel >= 1;

  const isShell = isShellTool(name);
  const hasShellCommand = isShell && !!shellCommand;

  // 有结果或进度就展开（结果默认通过 ToolResultDisplay 的 maxLines=3 折叠）
  const hasProgress = status === "executing" && progress !== undefined;
  const shouldExpandContent = !!resultDisplay || hasProgress;

  // Header 行：bash 工具不显示长命令（移到下方独立区域展示），header 保持简洁。
  // shell 工具 executing 时 header 已有 ToolStatusIndicator 的状态点流转，
  // 不再叠加 TrailingIndicator（避免重复动画，下方命令区域的实时颜色已足够）。
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
      {emphasis === "high" && !hasShellCommand && <TrailingIndicator />}
      <FocusHint name={name} status={status} />
    </Box>
  );

  // 命令截断计算（对标 cc BashTool/UI.tsx）
  // 非展开时：超过 2 行 / 160 字符则截断，尾部加 …；展开时展示完整命令
  const commandDisplay = React.useMemo(() => {
    if (!shellCommand) return null;
    if (isFullyExpanded) {
      return { text: `$ ${shellCommand}`, truncated: false, summary: "" };
    }

    // 统一换行符为 \n，兼容 Windows 的 \r\n（避免字符计数偏大、$ 与命令不对齐）
    const normalized = shellCommand.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const needsLineTruncation = lines.length > CMD_MAX_LINES;
    const needsCharTruncation = normalized.length > CMD_MAX_CHARS;

    if (!needsLineTruncation && !needsCharTruncation) {
      return { text: `$ ${normalized}`, truncated: false, summary: "" };
    }

    let truncated = normalized;
    let unit = "行";
    let count = 0;
    let hasLineCut = false;

    // 先按行截断
    if (needsLineTruncation) {
      count = lines.length - CMD_MAX_LINES;
      truncated = lines.slice(0, CMD_MAX_LINES).join("\n");
      hasLineCut = true;
    }

    // 再按字符截断（如先行截后仍超字符，说明保留的行中某行本身太长）
    if (truncated.length > CMD_MAX_CHARS) {
      const charCut = truncated.length - CMD_MAX_CHARS;
      if (hasLineCut) {
        // 双重截断：先去了 N 行，余下行又截了 M 字符，按维度分报告
        count += charCut;
        unit = "行/字符";
      } else {
        count = charCut;
        unit = "字符";
      }
      truncated = truncated.slice(0, CMD_MAX_CHARS);
    }

    return {
      text: `$ ${truncated.trim()}${ELLIPSIS}`,
      truncated: true,
      summary: formatCollapsedSummary(count, { unit, hint: "ctrl+o" }),
    };
  }, [shellCommand, isFullyExpanded]);

  // Shell 命令展示区域：非展开时截断 + 折叠提示；展开时换行展示完整命令
  // truncate-end：终端宽度不足时从末尾截断并追加 …，避免折行后破坏对齐节奏。
  // 已在 commandDisplay 中按 CMD_MAX_CHARS 预截断，truncate-end 用于兜底窄终端。
  // 2 空格缩进与 header 和结果区的视觉节奏一致
  const shellCommandSection =
    hasShellCommand && commandDisplay ? (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexShrink={0} width={2}>
            <Text> </Text>
          </Box>
          <Box flexGrow={1}>
            <Text
              color={
                status === "executing"
                  ? theme.text.primary
                  : theme.text.secondary
              }
              wrap={commandDisplay.truncated ? "truncate-end" : "wrap"}
            >
              {commandDisplay.text}
            </Text>
          </Box>
        </Box>
        {commandDisplay.truncated && (
          <Box flexDirection="row">
            <Box flexShrink={0} width={2}>
              <Text> </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={theme.text.secondary} dimColor>
                {commandDisplay.summary}
              </Text>
            </Box>
          </Box>
        )}
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
