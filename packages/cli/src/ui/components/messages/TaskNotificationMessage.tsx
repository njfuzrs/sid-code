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
import { Box } from "../../render-port/components.ts";
import { Text } from "../../render-port/components.ts";
import type { Color } from "../../render-port/types.ts";
import { theme } from "../../semantic-colors.ts";
import { getAgentInkColor } from "@sid-code/core/agent/color.ts";
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
  /**
   * 监控事件正文（monitor 的逐行事件通知带，§5.7.4）。
   *
   * 有值时摘要行改用 `<description> · <event 首行>`，bullet 用 `theme.text.secondary`
   * ——事件不是终态，不该用状态色（绿/红/黄只在「结束 / 失败 / 到期」时出现）。
   * 多行事件的其余行进 `⎿` 折叠区（复用同一个 SlicingMaxSizedBox，不新增组件）。
   */
  event?: string;
  /** 事件来源描述（monitor 的 `description`），摘要行前缀。 */
  description?: string;
  /**
   * 聚合了几条事件通知（D20，方案 §5.7.4）。
   *
   * `> 1` 时摘要行渲染成 `<description> · N 条事件`，事件正文**全部**逐行进 `⎿`
   * （首行不再占摘要行——摘要行已被计数占用）。缺省 / 1 走原来的单条事件路径。
   */
  eventCount?: number;
  terminalWidth: number;
}

/** 折叠档默认显示行数（对标 ToolResultDisplay 的 DEFAULT_MAX_LINES=3）。 */
const DEFAULT_MAX_LINES = 3;

/** 宽度感知换行安全边距（对标 ToolResultDisplay 的 WRAP_WIDTH_PADDING）。 */
const WRAP_WIDTH_PADDING = 8;

/** 终态 → bullet 颜色（仅换颜色不换字形，对标工具状态点流转 L3.2）。 */
function statusColor(status: string): Color {
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
  event,
  description,
  eventCount,
  terminalWidth,
}) => {
  // 与工具结果共享同一套 ctrl+o 阶梯展开语义：折叠档基线 = DEFAULT_MAX_LINES，
  // 全展开档返回 undefined（不截断）。
  const effectiveMaxLines = useExpandedMaxLines(DEFAULT_MAX_LINES);
  const maxColumnWidth = Math.max(terminalWidth - WRAP_WIDTH_PADDING, 20);

  // 监控事件：摘要行 = `<description> · <event 首行>`，其余行进 ⎿ 折叠区（§5.7.4）。
  // bullet 用次要色——事件不是终态，不用绿/红/黄（那三色只属于「结束 / 失败 / 到期」）。
  const isEvent = event !== undefined;
  const eventLines = isEvent ? event.split("\n") : [];
  // D20：聚合后的多项事件用「N 条事件」占摘要行，正文**全部**逐行进 ⎿；
  // 单条事件保持原样（首行在摘要，其余进 ⎿），不改变 T-M1-10 的既有渲染。
  const aggregated = (eventCount ?? 1) > 1;
  const eventFirstLine = eventLines[0] ?? "";
  const eventRest = eventLines.slice(1).join("\n");
  const displaySummary = !isEvent
    ? summary
    : aggregated
      ? `${description ? `${description} · ` : ""}${eventCount} 条事件`
      : description
        ? `${description} · ${eventFirstLine}`
        : eventFirstLine;
  // ⎿ 折叠区正文：聚合时是全部事件行（逐行），单条时是首行之后的剩余行。
  const branchText = aggregated ? eventLines.join("\n") : eventRest;

  return (
    <Box width={terminalWidth} flexDirection="column">
      {/* 摘要行：状态色 bullet + 摘要文本（对标工具 header） */}
      <Box flexDirection="row">
        <Box flexShrink={0} width={2}>
          <Text color={isEvent ? theme.text.secondary : statusColor(status)}>{BULLET}</Text>
        </Box>
        <Box flexGrow={1}>
          {/* P1-2：agent 身份色只点在类型标签上（克制点睛，不给整行上色）。 */}
          {agentType ? <Text color={getAgentInkColor(agentType)}>{`${agentType} `}</Text> : null}
          <Text wrap="wrap" color={isEvent ? theme.text.secondary : theme.text.primary}>
            {displaySummary}
          </Text>
        </Box>
      </Box>

      {/* 多行事件的其余行 / 终态结论：树枝缩进 + 折叠（复用 SlicingMaxSizedBox） */}
      {isEvent && branchText ? (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.text.secondary}>{`  ${TREE_BRANCH} `}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <SlicingMaxSizedBox
              text={branchText}
              maxLines={effectiveMaxLines}
              overflowDirection="bottom"
              maxColumnWidth={Math.max(1, maxColumnWidth - 4)}
              color={theme.text.secondary}
            />
          </Box>
        </Box>
      ) : !isEvent && result ? (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.text.secondary}>{`  ${TREE_BRANCH} `}</Text>
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
