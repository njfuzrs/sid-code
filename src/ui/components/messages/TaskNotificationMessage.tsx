/**
 * 后台任务完成通知组件（<task-notification>）
 *
 * 视觉语言对标工具结果（ToolMessage）：
 *   ⏺ Agent "核查 X" 执行完成              ← 状态色 bullet + 摘要
 *     ⎿ <子代理结论正文，默认折叠 maxLines>  ← 树枝缩进 + SlicingMaxSizedBox 折叠
 *
 * 背景：后台子代理/shell 完成后，<task-notification> XML 被当作 user 文本消息注入
 * 对话。此前走 UserMessage 全量渲染（`>` 前缀、不折叠），与同一任务的 task_output
 * 工具结果（走折叠路径）视觉割裂——用户看到「有的折叠、有的不折叠」。本组件让通知
 * 统一走折叠路径，复用 ToolResultDisplay 同款的 SlicingMaxSizedBox（不自造折叠）。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";
import { getAgentInkColor } from "../../../agent/color.ts";
import { BULLET, TREE_BRANCH } from "../../constants/figures.ts";
import { SlicingMaxSizedBox } from "../SlicingMaxSizedBox.tsx";
import { useExpandedMaxLines } from "../../contexts/UIStateContext.tsx";

interface TaskNotificationMessageProps {
  /** 一行摘要（如 'Agent "核查 X" 执行完成'） */
  summary: string;
  /** 任务终态：completed / failed / killed 等 */
  status: string;
  /** 结构化结果正文（子代理结论 / 错误信息），缺省时只显示摘要行 */
  result?: string;
  /**
   * P1-2：子代理类型。给摘要行加一个该 agent 的身份色标签（frontmatter 声明色优先，
   * 否则按类型哈希分配），多代理并行时用颜色区分是哪个 agent 回来的。缺省则不加标签。
   */
  agentType?: string;
  terminalWidth: number;
}

/** 折叠档默认显示行数（对标 ToolResultDisplay 的 DEFAULT_MAX_LINES=3）。 */
const DEFAULT_MAX_LINES = 3;

/** 宽度感知换行安全边距（对标 ToolResultDisplay 的 WRAP_WIDTH_PADDING）。 */
const WRAP_WIDTH_PADDING = 8;

/** 终态 → bullet 颜色（仅换颜色不换字形，对标工具状态点流转 L3.2）。 */
function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return theme.status.success;
    case "failed":
      return theme.status.error;
    case "killed":
      return theme.status.warning;
    default:
      return theme.text.secondary;
  }
}

export const TaskNotificationMessage: React.FC<TaskNotificationMessageProps> = ({
  summary,
  status,
  result,
  agentType,
  terminalWidth,
}) => {
  // 与工具结果共享同一套 ctrl+o 阶梯展开语义：折叠档基线 = DEFAULT_MAX_LINES，
  // 全展开档返回 undefined（不截断）。
  const effectiveMaxLines = useExpandedMaxLines(DEFAULT_MAX_LINES);
  const maxColumnWidth = Math.max(terminalWidth - WRAP_WIDTH_PADDING, 20);

  return (
    <Box width={terminalWidth} flexDirection="column">
      {/* 摘要行：状态色 bullet + 摘要文本（对标工具 header） */}
      <Box flexDirection="row">
        <Box flexShrink={0} width={2}>
          <Text color={statusColor(status)}>{BULLET}</Text>
        </Box>
        <Box flexGrow={1}>
          {/* P1-2：agent 身份色只点在类型标签上（克制点睛，不给整行上色）。 */}
          {agentType ? (
            <Text color={getAgentInkColor(agentType)}>{`${agentType} `}</Text>
          ) : null}
          <Text wrap="wrap" color={theme.text.primary}>{summary}</Text>
        </Box>
      </Box>

      {/* 结果正文：树枝缩进 + 折叠（复用 SlicingMaxSizedBox，与工具结果一致） */}
      {result ? (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.text.secondary} dimColor>{`  ${TREE_BRANCH} `}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <SlicingMaxSizedBox
              text={result}
              maxLines={effectiveMaxLines}
              overflowDirection="bottom"
              maxColumnWidth={Math.max(1, maxColumnWidth - 4)}
              color={theme.text.secondary}
            />
          </Box>
        </Box>
      ) : null}
    </Box>
  );
};
