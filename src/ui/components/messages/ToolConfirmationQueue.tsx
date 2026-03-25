/**
 * 工具确认队列组件
 *
 * 嵌入消息流末尾（而非独立对话框弹出），显示需要用户确认的工具调用。
 * 带圆角边框，显示工具名称、描述和确认操作。
 *
 * 参考 gemini-cli ToolConfirmationQueue.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../semantic-colors.ts";
import { ToolStatusIndicator, ToolInfo } from "./ToolShared.tsx";
import { StickyHeader } from "../StickyHeader.tsx";
import type { ConfirmingToolState } from "../../hooks/useConfirmingTool.ts";
import { getToolSummary } from "../../ui-utils.ts";

interface ToolConfirmationQueueProps {
  confirmingTool: ConfirmingToolState;
  terminalWidth: number;
}

export const ToolConfirmationQueue: React.FC<ToolConfirmationQueueProps> = ({
  confirmingTool,
  terminalWidth,
}) => {
  const { tool, index, total } = confirmingTool;
  const borderColor = theme.status.warning;
  const contentWidth = Math.max(20, terminalWidth - 4);

  return (
    <Box flexDirection="column" width={terminalWidth} flexShrink={0}>
      <StickyHeader
        width={terminalWidth}
        isFirst={true}
        borderColor={borderColor}
        borderDimColor={false}
      >
        <Box flexDirection="column" width={contentWidth}>
          {/* 标题行 */}
          <Box justifyContent="space-between" marginBottom={1}>
            <Text color={borderColor} bold>
              需要确认
            </Text>
            {total > 1 && (
              <Text color={theme.text.secondary}>
                {index} / {total}
              </Text>
            )}
          </Box>

          {/* 工具信息 */}
          <Box>
            <ToolStatusIndicator status="confirming" />
            <ToolInfo
              name={tool.name}
              status="confirming"
              description={getToolSummary(tool.name, tool.input)}
              emphasis="high"
            />
          </Box>
        </Box>
      </StickyHeader>

      {/* 中间内容区域 */}
      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={borderColor}
        borderTop={false}
        borderBottom={false}
        borderLeft={true}
        borderRight={true}
        paddingX={1}
        flexDirection="column"
      >
        {/* 工具描述 */}
        <Box marginY={0}>
          <Text color={theme.text.secondary}>
            {tool.description || getToolSummary(tool.name, tool.input)}
          </Text>
        </Box>
      </Box>

      {/* 底部边框 */}
      <Box
        height={0}
        width={terminalWidth}
        borderLeft={true}
        borderRight={true}
        borderTop={false}
        borderBottom={true}
        borderColor={borderColor}
        borderStyle="round"
      />
    </Box>
  );
};
