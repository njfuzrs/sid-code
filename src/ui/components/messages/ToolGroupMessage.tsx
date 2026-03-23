/**
 * 工具调用分组消息组件
 *
 * 将多个工具调用渲染在一个圆角边框内，边框颜色随执行状态变化。
 * 参考 gemini-cli ToolGroupMessage.tsx
 */

import React, { useMemo } from "react";
import { Box } from "ink";
import { ToolMessage } from "./ToolMessage.tsx";
import { getToolGroupBorderAppearance } from "../../utils/borderStyles.ts";
import type { ToolCallStatus } from "./ToolShared.tsx";
import { getToolSummary, getResultSummary, isDiffContent, getFilenameFromInput } from "../../ui-utils.ts";
export interface ToolCallDisplay {
  id: string;
  name: string;
  input: unknown;
  status: ToolCallStatus;
  result?: string;
  isError?: boolean;
}

interface ToolGroupMessageProps {
  tools: ToolCallDisplay[];
  terminalWidth: number;
}

const TOOL_MESSAGE_HORIZONTAL_MARGIN = 4;

export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  tools,
  terminalWidth,
}) => {
  const { borderColor, borderDimColor } = useMemo(
    () => getToolGroupBorderAppearance(tools),
    [tools],
  );

  if (tools.length === 0) return null;

  const contentWidth = terminalWidth - TOOL_MESSAGE_HORIZONTAL_MARGIN;

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      paddingRight={TOOL_MESSAGE_HORIZONTAL_MARGIN}
    >
      {tools.map((tool, index) => {
        const isDiff = tool.result ? isDiffContent(tool.name, tool.result) : false;
        const filename = getFilenameFromInput(tool.name, tool.input);

        return (
          <ToolMessage
            key={tool.id}
            name={tool.name}
            description={getToolSummary(tool.name, tool.input)}
            resultDisplay={tool.result ? (isDiff ? tool.result : getResultSummary(tool.name, tool.result, tool.isError)) : undefined}
            status={tool.status}
            terminalWidth={contentWidth}
            isFirst={index === 0}
            borderColor={borderColor}
            borderDimColor={borderDimColor}
            isError={tool.isError}
            isDiff={isDiff}
            filename={filename}
          />
        );
      })}
      {/* 底部边框 */}
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
    </Box>
  );
};
