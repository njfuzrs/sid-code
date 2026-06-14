/**
 * 计划审阅消息组件
 *
 * 单一圆角容器 + 内部一条 borderTop 分隔线，取代此前 gemini-cli 遗留的
 * 四段 Box 拼接边框（顶/分隔/中/底）。结构更干净，无盒子套盒子。
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
    <Box
      flexDirection="column"
      width={terminalWidth}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      {/* 标题行：成功色圆点 + 标题 + 行数 */}
      <Box justifyContent="space-between">
        <Box>
          <Text color={borderColor} bold>{"● 计划审阅"}</Text>
        </Box>
        <Text dimColor>{lineCount} 行</Text>
      </Box>
      <Text color={theme.text.link}>{planFilePath}</Text>

      {/* 标题与内容之间的分隔线：内部一条 borderTop，不再拼接独立边框段 */}
      <Box
        width={contentWidth}
        borderStyle="single"
        borderColor={theme.ui.dark ?? theme.border.default}
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        marginY={0}
      />

      {/* 计划内容 */}
      <Box flexDirection="column">
        <MarkdownDisplay
          text={planContent}
          isPending={false}
          terminalWidth={contentWidth}
          renderMarkdown={true}
        />
      </Box>
    </Box>
  );
};
