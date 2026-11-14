/**
 * 工具调用分组消息组件
 *
 * 视觉语言对标 claude-code：去掉圆角边框，组内工具纯竖向排列，
 * 每条工具一个 ⏺ bullet（状态色），组本身不画框。
 */

import React, { useEffect, useRef } from "react";
import { Box } from "../../render-port/components.ts";
import { Text } from "../../render-port/components.ts";
import { ToolMessage } from "./ToolMessage.tsx";
import { isShellTool, type ToolCallStatus } from "./ToolShared.tsx";
import {
  getToolSummary,
  getResultSummary,
  isDiffContent,
  getFilenameFromInput,
  getThinkThought,
} from "../../ui-utils.ts";
import { useOverflowState } from "../../contexts/OverflowContext.tsx";
import { useUIState } from "../../contexts/UIStateContext.tsx";
import { shouldShowHint, markHintShown } from "@sid-code/core/config/app-config.ts";
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
  agentProgress?: import("@sid-code/core/agent/progress.ts").AgentProgressSnapshot;
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
  /**
   * 呈现档位（源自工具自报的 `resultDisplayMode`，见 `tool/types.ts`）。
   * `"hidden"` 的完成态工具整条不渲染；`"summary"` 只渲染 header 行；
   * `"compact"` 保留正文但默认折叠成零行，`ctrl+o` 可展开（见 `ToolMessage`）；
   * `"full"` 保留正文且**不做任何行数截断**（短回执工具，见 `ToolMessage`）。
   */
  displayMode?: "hidden" | "summary" | "compact" | "full";
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

/**
 * compact 折叠态的「还能展开」引导提示。
 *
 * 为什么必须单独给一次：compact 卡片刻意不渲染 `ToolResultDisplay`，因而**不登记溢出**，
 * 下面那行 `isExpandable && hasOverflow` 的提示永远不会为它出现。折叠了却没有任何线索
 * 说明正文还在，就等于把「省地方」做成了「藏信息」——`src/ui/CLAUDE.md` L3.3 明文要求
 * 折叠时给摘要 + 可展开提示，正是防这个。
 *
 * 为什么是 3 次而不是常显：这是一条 onboarding 提示，`ctrl+o` 学会之后每轮多一行就是纯噪音，
 * 会把折叠省下来的行又还回去。按 L4-C 的渐进衰减接 `app-config` 的通用计数器
 * （`shouldShowHint` / `markHintShown`），看满 3 次收敛。
 */
const COMPACT_EXPAND_HINT_KEY = "toolResultCompactExpand";
const COMPACT_EXPAND_HINT_MAX_SHOWS = 3;

export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  tools,
  terminalWidth,
  isExpandable = false,
}) => {
  // 历史区渲染全部工具，但滤掉自报 hidden 的**已完成**卡片。
  //
  // 对标 cc：`userFacingName()` 返 `''` 的工具在 `AssistantToolUseMessage.tsx:158`
  // 直接 `return null`，连 `⏺ 工具名` 那行都不画（`todo_write` / `tool_search` 即如此）。
  // 我们等价地在组内过滤——去掉的是整条卡片，不只是 `⎿` 正文。
  //
  // ⚠️ **只滤完成态（有 result 的），executing 态必须留着。** 两个理由：
  //   1. 长跑工具（如 delegate skill、workflow）执行期间若卡片不可见，用户看到的是
  //      「界面卡住、什么都没发生」——这正是本仓库反复治过的"过程黑盒"缺陷，
  //      比啰嗦严重得多（见 src/ui/CLAUDE.md L3.2「状态即时可见」）。
  //   2. hidden 的语义是「结果对用户零信息量」，不是「这一步不存在」。
  //  执行中卡片没有结果正文可泄漏，本就无害；它一完成就整条退场，屏幕自然收干净。
  //
  // 错误结果同样保留：执行器不给错误 block 打标记，`buildCompletedToolCall` 再守一道，
  // 所以带 isError 的卡片拿不到 displayMode，不会走到这里被滤掉。
  // 判定写成 `status === "success"` 而非 `!== "executing"`：状态共 5 档
  // （pending / executing / success / error / cancelled），只有 success 才该退场。
  //   - pending（排队等权限）与 executing 都还没有结果，留着表达"这一步在进行"；
  //   - error / cancelled 是用户必须看到的异常收尾，绝不隐藏。
  const visibleTools = tools.filter((t) => !(t.displayMode === "hidden" && t.status === "success"));

  // 检查是否有溢出内容（通过 OverflowContext）
  const overflowState = useOverflowState();
  const hasOverflow = overflowState ? overflowState.overflowingIds.size > 0 : false;

  const { expandLevel } = useUIState();

  // 组内有没有「被折成零行正文」的卡片。它们刻意不登记溢出（早退分支不渲染
  // ToolResultDisplay，见 ToolMessage），所以下面那句 `isExpandable && hasOverflow`
  // 永远不会为它们出现——折叠了却不告诉用户能展开，正文就等于被藏掉了
  // （`src/ui/CLAUDE.md` L3.3：折叠时给摘要 + 可展开提示）。
  //
  // 展开态（expandLevel ≥ 1）不提示：此时正文已经在屏幕上，再提示就是噪音。
  const hasCompactCollapsed =
    expandLevel === 0 &&
    visibleTools.some((t) => t.displayMode === "compact" && t.status === "success" && !t.isError);

  // L4-C 接线套路：在「提示首次出现」时锁定形态并记一次，避免每帧重复计数。
  // 本组件在 `<Static>` 里每组只渲染一次，ref 初始化即那一次的结果。
  const compactHintRef = useRef<boolean | null>(null);
  if (compactHintRef.current === null) {
    compactHintRef.current =
      hasCompactCollapsed && shouldShowHint(COMPACT_EXPAND_HINT_KEY, COMPACT_EXPAND_HINT_MAX_SHOWS);
  }
  const showCompactHint = hasCompactCollapsed && compactHintRef.current === true;
  useEffect(() => {
    if (showCompactHint) markHintShown(COMPACT_EXPAND_HINT_KEY);
  }, [showCompactHint]);

  // 溢出提示（普通工具结果被截断）与 compact 提示共用同一行文案：对用户来说都是
  // 「按 ctrl+o 把正文调出来」，分成两句反而要分别理解。
  const showExpandHint = (isExpandable && hasOverflow) || showCompactHint;

  if (visibleTools.length === 0) return null;

  // 本组内**同时在跑**的子代理数。同批 fan-out 的 sub_agent 天然落在同一个 tool_group
  // （同一条 assistant 消息里的多个 tool_use），所以组内计数就是并行度，无需外部传入。
  // 决定呈现档位：1 个 → 展开活动明细；多个 → 每 agent 一行（见 agent-progress-view.ts）。
  const concurrentAgentCount = visibleTools.filter((t) => !!t.agentProgress).length;

  const contentWidth = terminalWidth - TOOL_MESSAGE_HORIZONTAL_MARGIN;

  return (
    <Box flexDirection="column" width={terminalWidth} paddingRight={TOOL_MESSAGE_HORIZONTAL_MARGIN}>
      {visibleTools.map((tool, index) => {
        // 结构化 diff 优先(从 Message[] 重建路径携带);缺失时降级到对 result 文本的正则检测。
        const hasPatch = !!tool.structuredPatch?.length;
        const isDiff = hasPatch || (tool.result ? isDiffContent(tool.name, tool.result) : false);
        const filename = tool.filename ?? getFilenameFromInput(tool.name, tool.input);

        // bash/shell 工具：提取完整命令行供独立换行展示
        const shellCommand =
          tool.shellCommand != null
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
            // summary / hidden 档不重算摘要：`resultSummary` 与 `result` 都已被置空，
            // 若沿用 `||` 兜底链去重算，`getResultSummary` 会用 `N 字符` 量**那份提示词**
            // 的长度（实测 todo_write 曾报 "258 字符"，描述的是前向推进指令本身）。
            // 该档的信息重心在 header 的 description，摘要留空正是想要的。
            //
            // compact 档**必须重算/保留摘要**：它是折叠态标题行唯一的结果规模信息
            // （「54 行输出」「12 个结果」），丢了就只剩「⏺ bash <命令>」一行、读者
            // 完全不知道跑了多少东西——折叠就从「省地方」退化成「藏信息」。
            resultSummary={
              tool.displayMode === "hidden" || tool.displayMode === "summary"
                ? undefined
                : tool.resultSummary ||
                  (tool.result ? getResultSummary(tool.name, tool.result, tool.isError) : undefined)
            }
            elapsedMs={tool.elapsedMs}
            shellCommand={shellCommand}
            thinkThought={thinkThought}
            displayMode={tool.displayMode}
          />
        );
      })}
      {showExpandHint && (
        <Box paddingLeft={2}>
          <Text color={theme.text.secondary}>ctrl+o 展开完整输出</Text>
        </Box>
      )}
    </Box>
  );
};
