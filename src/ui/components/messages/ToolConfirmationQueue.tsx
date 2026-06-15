/**
 * 工具确认队列组件
 *
 * 嵌入消息流末尾（动态区底部，紧贴输入框上方，不在虚拟滚动列表内），
 * 显示需要用户确认的工具调用。
 *
 * 单一圆角容器 + 内部一条 borderTop 分隔线，取代此前的 StickyHeader
 * 三段式边框拼接（sticky 行为在动态区底部是多余的）。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";
import { ToolStatusIndicator, ToolInfo } from "./ToolShared.tsx";
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
    <Box
      flexDirection="column"
      width={terminalWidth}
      flexShrink={0}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      {/* 标题行：需要确认 + 队列进度 */}
      <Box justifyContent="space-between">
        <Text color={borderColor} bold>需要确认</Text>
        {total > 1 && (
          <Text color={theme.text.secondary}>
            {index} / {total}
          </Text>
        )}
      </Box>

      {/* 工具信息：confirming 状态圆点 + 名称 + 摘要 */}
      <Box marginTop={1}>
        <ToolStatusIndicator status="confirming" />
        <ToolInfo
          name={tool.name}
          status="confirming"
          description={getToolSummary(tool.name, tool.input)}
          emphasis="high"
        />
      </Box>

      {/* 分隔线：内部一条 borderTop，不再拼接独立边框段 */}
      <Box
        width={contentWidth}
        borderStyle="single"
        borderColor={theme.ui.dark}
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        marginY={1}
      />

      {/* 工具描述 */}
      <Box>
        <Text color={theme.text.secondary}>
          {tool.description || getToolSummary(tool.name, tool.input)}
        </Text>
      </Box>
    </Box>
  );
};
