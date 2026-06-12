/**
 * 计划审阅消息组件
 *
 * 参考 gemini-cli ToolConfirmationQueue 的三段式边框拼接：
 * - 顶部 Box：borderTop + 标题
 * - 中间 Box：左右边框 + 计划内容
 * - 底部 Box：borderBottom
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { MarkdownDisplay } from "../MarkdownDisplay.tsx";
import { theme } from "../../semantic-colors.ts";

interface PlanReviewMessageProps {
  planContent: string;
  planFilePath: string;
  terminalWidth: number;
}

export const PlanReviewMessage: React.FC<PlanReviewMessageProps> = ({
  planContent,
  planFilePath,
  terminalWidth,
}) => {
  const lineCount = planContent.split("\n").length;
  const borderColor = theme.status.success;
  // 内容宽度 = 总宽度 - 左右边框(2) - 左右 paddingX(2)
  const contentWidth = terminalWidth - 4;

  return (
    <Box flexDirection="column" width={terminalWidth}>
      {/* 顶部：borderTop + 左右边框 + 标题 */}
      <Box
        borderStyle="round"
        borderColor={borderColor}
        borderTop={true}
        borderBottom={false}
        borderLeft={true}
        borderRight={true}
        width={terminalWidth}
        paddingX={1}
        flexDirection="column"
      >
        <Box justifyContent="space-between">
          <Text color={borderColor} bold>📋 计划审阅</Text>
          <Text dimColor>{lineCount} 行</Text>
        </Box>
        <Text color={theme.text.link}>{planFilePath}</Text>
      </Box>

      {/* 标题与内容之间的分隔线 */}
      <Box
        borderStyle="round"
        borderColor={borderColor}
        borderTop={false}
        borderBottom={false}
        borderLeft={true}
        borderRight={true}
        width={terminalWidth}
      >
        <Box
          width={terminalWidth - 2}
          borderStyle="single"
          borderColor={theme.ui.dark ?? theme.border.default}
          borderTop={false}
          borderBottom={true}
          borderLeft={false}
          borderRight={false}
        />
      </Box>

      {/* 中间：左右边框 + 计划内容 */}
      <Box
        borderStyle="round"
        borderColor={borderColor}
        borderTop={false}
        borderBottom={false}
        borderLeft={true}
        borderRight={true}
        width={terminalWidth}
        paddingX={1}
        flexDirection="column"
      >
        <MarkdownDisplay
          text={planContent}
          isPending={false}
          terminalWidth={contentWidth}
          renderMarkdown={true}
        />
      </Box>

      {/* 底部：borderBottom + 左右边框 */}
      <Box
        height={1}
        width={terminalWidth}
        borderStyle="round"
        borderColor={borderColor}
        borderTop={false}
        borderBottom={true}
        borderLeft={true}
        borderRight={true}
      />
    </Box>
  );
};
