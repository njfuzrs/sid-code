/**
 * 工具调用分组消息组件
 *
 * 视觉语言对标 claude-code：去掉圆角边框，组内工具纯竖向排列，
 * 每条工具一个 ⏺ bullet（状态色），组本身不画框。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { ToolMessage } from "./ToolMessage.tsx";
import { isShellTool, type ToolCallStatus } from "./ToolShared.tsx";
import { getToolSummary, getResultSummary, isDiffContent, getFilenameFromInput, getThinkThought } from "../../ui-utils.ts";
import { useOverflowState } from "../../contexts/OverflowContext.tsx";
import { theme } from "../../semantic-colors.ts";

export interface ToolCallDisplay {
  id: string;
  name: string;
  input: unknown;
  status: ToolCallStatus;
  result?: string;
  isError?: boolean;
  /** 工具描述（参数摘要，如文件路径、命令等） */
  description?: string;
  /** 是否渲染输出为 Markdown */
  renderOutputAsMarkdown?: boolean;
  /** MCP 进度消息 */
  progressMessage?: string;
  /** 子代理实时进度（仅执行中的 sub_agent 有值） */
  agentProgress?: import("../../../agent/progress.ts").AgentProgressSnapshot;
  /** MCP 进度值 */
  progress?: number;
  /** MCP 进度总量 */
  progressTotal?: number;
  /** 结果摘要（一行文字） */
  resultSummary?: string;
  /** 结构化 diff(edit/write):优先于 result 文本渲染高亮 */
  structuredPatch?: import("diff").StructuredPatchHunk[];
  /** 文件名(diff 语法高亮用) */
  filename?: string;
  /** 工具执行耗时（毫秒），完成态时由后端填入。缺省时不显示 */
  elapsedMs?: number;
  /** bash/shell 工具的完整命令行文本 */
  shellCommand?: string;
}

interface ToolGroupMessageProps {
  tools: ToolCallDisplay[];
  terminalWidth: number;
  /** @deprecated 去盒子后无边框，保留以兼容调用方（HistoryItemDisplay） */
  borderTop?: boolean;
  /** @deprecated 去盒子后无边框，保留以兼容调用方 */
  borderBottom?: boolean;
  /** 是否可展开（Ctrl+O 展开被截断的输出） */
  isExpandable?: boolean;
}

const TOOL_MESSAGE_HORIZONTAL_MARGIN = 4;

export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  tools,
  terminalWidth,
  isExpandable = false,
}) => {
  // 历史区直接渲染全部工具：此前会过滤 confirming 态（在独立确认队列渲染），
  // 但确认体系已统一走 PermissionPrompt，confirming 态及其队列组件已移除。
  const visibleTools = tools;

  // 检查是否有溢出内容（通过 OverflowContext）
  const overflowState = useOverflowState();
  const hasOverflow = overflowState
    ? overflowState.overflowingIds.size > 0
    : false;

  // 是否显示展开提示
  const showExpandHint = isExpandable && hasOverflow;

  if (visibleTools.length === 0) return null;

  // 本组内**同时在跑**的子代理数。同批 fan-out 的 sub_agent 天然落在同一个 tool_group
  // （同一条 assistant 消息里的多个 tool_use），所以组内计数就是并行度，无需外部传入。
  // 决定呈现档位：1 个 → 展开活动明细；多个 → 每 agent 一行（见 agent-progress-view.ts）。
  const concurrentAgentCount = visibleTools.filter((t) => !!t.agentProgress).length;

  const contentWidth = terminalWidth - TOOL_MESSAGE_HORIZONTAL_MARGIN;

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      paddingRight={TOOL_MESSAGE_HORIZONTAL_MARGIN}
    >
      {visibleTools.map((tool, index) => {
        // 结构化 diff 优先(从 Message[] 重建路径携带);缺失时降级到对 result 文本的正则检测。
        const hasPatch = !!tool.structuredPatch?.length;
        const isDiff = hasPatch || (tool.result ? isDiffContent(tool.name, tool.result) : false);
        const filename = tool.filename ?? getFilenameFromInput(tool.name, tool.input);

        // bash/shell 工具：提取完整命令行供独立换行展示
        const shellCommand = tool.shellCommand != null
          ? tool.shellCommand
          : isShellTool(tool.name)
            ? (tool.input as any)?.command || ""
            : undefined;

        // think 工具：思考正文在 input 里（工具结果只是无信息确认语），取出交给结果区展示
        const thinkThought = getThinkThought(tool.name, tool.input);

        return (
          <ToolMessage
            key={tool.id}
            name={tool.name}
            description={tool.description || getToolSummary(tool.name, tool.input)}
            resultDisplay={tool.result || undefined}
            status={tool.status}
            terminalWidth={contentWidth}
            isFirst={index === 0}
            isError={tool.isError}
            isDiff={isDiff}
            filename={filename}
            structuredPatch={tool.structuredPatch}
            renderOutputAsMarkdown={tool.renderOutputAsMarkdown}
            progressMessage={tool.progressMessage}
            agentProgress={tool.agentProgress}
            // 并行子代理数从**本组**统计：同批 fan-out 的 sub_agent 天然在同一个
            // tool_group（同一条 assistant 消息里的多个 tool_use）。据此选呈现档位——
            // 1 个就展开活动明细，多个就每 agent 压成一行（见 agent-progress-view.ts）。
            concurrentAgentCount={concurrentAgentCount}
            progress={tool.progress}
            progressTotal={tool.progressTotal}
            resultSummary={tool.resultSummary || (tool.result ? getResultSummary(tool.name, tool.result, tool.isError) : undefined)}
            elapsedMs={tool.elapsedMs}
            shellCommand={shellCommand}
            thinkThought={thinkThought}
          />
        );
      })}
      {showExpandHint && (
        <Box paddingLeft={2}>
          <Text dimColor color={theme.text.secondary}>
            ctrl+o 展开完整输出
          </Text>
        </Box>
      )}
    </Box>
  );
};
