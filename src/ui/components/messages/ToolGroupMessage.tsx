/**
 * 工具调用分组消息组件
 *
 * 将多个工具调用渲染在一个圆角边框内，边框颜色随执行状态变化。
 * 参考 gemini-cli ToolGroupMessage.tsx
 *
 * P1 增强：
 * - 支持 borderTop/borderBottom 覆盖
 * - 支持 renderOutputAsMarkdown
 * - 支持 MCP 进度指示器
 * - 过滤 Confirming 状态的工具（在确认队列中渲染）
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { ToolMessage } from "./ToolMessage.tsx";
import { getToolGroupBorderAppearance } from "../../utils/borderStyles.ts";
import type { ToolCallStatus } from "./ToolShared.tsx";
import { getToolSummary, getResultSummary, isDiffContent, getFilenameFromInput } from "../../ui-utils.ts";
import { useOverflowState } from "../../contexts/OverflowContext.tsx";
import { theme } from "../../semantic-colors.ts";

export interface ToolCallDisplay {
  id: string;
  name: string;
  input: unknown;
  status: ToolCallStatus;
  result?: string;
  isError?: boolean;
  /** 是否渲染输出为 Markdown */
  renderOutputAsMarkdown?: boolean;
  /** MCP 进度消息 */
  progressMessage?: string;
  /** MCP 进度值 */
  progress?: number;
  /** MCP 进度总量 */
  progressTotal?: number;
}

interface ToolGroupMessageProps {
  tools: ToolCallDisplay[];
  terminalWidth: number;
  /** 是否渲染顶部边框（覆盖默认行为） */
  borderTop?: boolean;
  /** 是否渲染底部边框（覆盖默认行为） */
  borderBottom?: boolean;
  /** 是否可展开（Ctrl+O 展开被截断的输出） */
  isExpandable?: boolean;
}

const TOOL_MESSAGE_HORIZONTAL_MARGIN = 4;

export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  tools,
  terminalWidth,
  borderTop: borderTopOverride,
  borderBottom: borderBottomOverride,
  isExpandable = false,
}) => {
  // 过滤 confirming 状态的工具（在确认队列中渲染，不在历史中显示）
  const visibleTools = useMemo(
    () => tools.filter(t => t.status !== "confirming"),
    [tools],
  );

  const { borderColor, borderDimColor } = useMemo(
    () => getToolGroupBorderAppearance(visibleTools),
    [visibleTools],
  );

  // 检查是否有溢出内容（通过 OverflowContext）
  const overflowState = useOverflowState();
  const hasOverflow = overflowState
    ? overflowState.overflowingIds.size > 0
    : false;

  // 是否显示展开提示
  const showExpandHint = isExpandable && hasOverflow;

  if (visibleTools.length === 0) return null;

  const contentWidth = terminalWidth - TOOL_MESSAGE_HORIZONTAL_MARGIN;

  // 是否显示底部边框
  const showBottomBorder = borderBottomOverride !== false;

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      paddingRight={TOOL_MESSAGE_HORIZONTAL_MARGIN}
    >
      {visibleTools.map((tool, index) => {
        const isDiff = tool.result ? isDiffContent(tool.name, tool.result) : false;
        const filename = getFilenameFromInput(tool.name, tool.input);
        const isFirst = index === 0;
        const resolvedIsFirst =
          borderTopOverride !== undefined
            ? borderTopOverride && isFirst
            : isFirst;

        return (
          <ToolMessage
            key={tool.id}
            name={tool.name}
            description={getToolSummary(tool.name, tool.input)}
            resultDisplay={tool.result ? (isDiff ? tool.result : getResultSummary(tool.name, tool.result, tool.isError)) : undefined}
            status={tool.status}
            terminalWidth={contentWidth}
            isFirst={resolvedIsFirst}
            borderColor={borderColor}
            borderDimColor={borderDimColor}
            isError={tool.isError}
            isDiff={isDiff}
            filename={filename}
            renderOutputAsMarkdown={tool.renderOutputAsMarkdown}
            progressMessage={tool.progressMessage}
            progress={tool.progress}
            progressTotal={tool.progressTotal}
          />
        );
      })}
      {/* 底部边框 + 可选展开提示 */}
      {showBottomBorder && (
        <Box
          height={0}
          width={contentWidth}
          borderLeft={true}
          borderRight={true}
          borderTop={false}
          borderBottom={true}
          borderColor={borderColor}
          borderDimColor={borderDimColor}
          borderStyle="round"
        />
      )}
      {showExpandHint && (
        <Box paddingLeft={2}>
          <Text dimColor color={theme.text.secondary}>
            Ctrl+O 展开完整输出
          </Text>
        </Box>
      )}
    </Box>
  );
};
