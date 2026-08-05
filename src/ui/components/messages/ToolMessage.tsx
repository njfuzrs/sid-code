/**
 * 单个工具消息组件
 *
 * 视觉语言对标 claude-code：去掉所有圆角边框盒子，改为
 *   ⏺ ToolName(参数摘要) — 结果摘要        ← 状态色 bullet + 工具信息
 *     ⎿ diff / 错误 / 进度                 ← 树枝缩进 2 空格
 *
 * 紧凑模式：成功结果只显示一行 header（name + description + 摘要）
 * 展开模式：错误 / diff / 进度 在树枝缩进区展开
 *
 * bash/shell 工具特殊处理：命令从 header 单行移到独立区域展示。
 * 对标 cc BashTool/UI.tsx，默认截断到 2 行 / 160 字符，ctrl+o 展开完整命令。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import {
  ToolStatusIndicator,
  ToolInfo,
  TrailingIndicator,
  McpProgressIndicator,
  FocusHint,
  isShellTool,
  isPathDescriptionTool,
  type ToolCallStatus,
  type TextEmphasis,
} from "./ToolShared.tsx";
import { ToolResultDisplay } from "./ToolResultDisplay.tsx";
import { SlicingMaxSizedBox } from "../SlicingMaxSizedBox.tsx";
import { THINK_HEADER_LABEL } from "../../ui-utils.ts";
import { theme } from "../../semantic-colors.ts";
import { TREE_BRANCH } from "../../constants/figures.ts";
import { useUIState, useExpandedMaxLines } from "../../contexts/UIStateContext.tsx";
import { truncateShellCommand } from "../../constants/collapse.ts";
import { useTerminalDimensionsOptional } from "../../contexts/TerminalContext.tsx";
import { selectAgentProgressTier, formatAgentProgressLine } from "../../agent-progress-view.ts";
import { formatLargeNumber } from "../../utils/format-number.ts";
import { formatDuration } from "../../utils/format-duration.ts";

/**
 * think 思考正文的折叠基线（视觉行）。
 *
 * 比普通工具结果（3 行）宽松：思考本身就是要给人读的推理，3 行读不出所以然；
 * 但也不能不折叠——连续多次 think 会灌满屏幕。8 行够展示一段完整推理的主干，
 * 超出走统一的 `… N 行已折叠 · ctrl+o 展开`。
 */
const THINK_COLLAPSE_MAX_LINES = 8;

/** 思考正文换行的安全边距（与 ToolResultDisplay 的 WRAP_WIDTH_PADDING 同量级）。 */
const THINK_WRAP_PADDING = 8;

export interface ToolMessageProps {
  name: string;
  description: string;
  resultDisplay?: string;
  /**
   * think 工具记录的思考正文（来自 input.thought）。
   *
   * think 的工具**结果**只是一句无信息确认语「已记录思考。」，真正的内容在输入里。
   * 传入后结果区（⎿）改为展示这段思考正文，用户才看得出记了什么。
   */
  thinkThought?: string;
  status: ToolCallStatus;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  isFirst: boolean;
  /** @deprecated 去盒子后不再控制底部边框，保留以兼容调用方 */
  isLast?: boolean;
  isError?: boolean;
  isDiff?: boolean;
  filename?: string;
  /** 结构化 diff(edit/write):优先于 resultDisplay 文本渲染 */
  structuredPatch?: import("diff").StructuredPatchHunk[];
  renderOutputAsMarkdown?: boolean;
  progressMessage?: string;
  /**
   * 子代理实时进度（仅执行中的 `sub_agent` 有值）。
   * 治"子代理过程黑盒"：跑 1m35s 主消息流一个字都没有，末尾一把吐出。
   */
  agentProgress?: import("../../../agent/progress.ts").AgentProgressSnapshot;
  /** 同组内并行的子代理数（决定进度呈现档位，见 agent-progress-view.ts） */
  concurrentAgentCount?: number;
  progress?: number;
  progressTotal?: number;
  resultSummary?: string;
  /** 工具执行耗时（毫秒），完成态时显示在工具名后。缺省时不显示 */
  elapsedMs?: number;
  /** bash/shell 工具的完整命令行文本（独立区域自然换行展示） */
  shellCommand?: string;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  terminalWidth,
  emphasis = "medium",
  isError,
  isDiff = false,
  filename,
  structuredPatch,
  renderOutputAsMarkdown = false,
  progressMessage,
  agentProgress,
  concurrentAgentCount = 1,
  progress,
  progressTotal,
  resultSummary,
  elapsedMs,
  shellCommand,
  thinkThought,
}) => {
  const { expandLevel } = useUIState();
  // 终端高度决定子代理进度是展开活动明细还是压成一行（见 selectAgentProgressTier）。
  // 用 Optional 版：高度只是排版提示，拿不到照样正确渲染（档位按"充裕"处理），
  // 不该为此逼所有渲染 ToolMessage 的地方都套 TerminalProvider。
  const terminalHeight = useTerminalDimensionsOptional()?.height;
  // 思考正文折叠档：与工具结果/命令输出共用同一套 ctrl+o 阶梯展开语义
  // （全展开档返回 undefined = 不截断）。
  const thinkMaxLines = useExpandedMaxLines(THINK_COLLAPSE_MAX_LINES);
  // 展开级别：0=折叠 1=更多 2=全展开。level >= 1 时命令不再截断，
  // 让用户按一次 ctrl+o 即可看到完整命令（对标 cc 的阶梯展开直觉）。
  const isFullyExpanded = expandLevel >= 1;

  const isShell = isShellTool(name);
  const hasShellCommand = isShell && !!shellCommand;

  // description 是文件路径的工具：收缩时要从**头部**省略目录以保住文件名
  // （`…/todo/x.md`），而不是砍掉尾部只留下每行都一样的 `/Users/…/sid-code/` 前缀。
  const descriptionIsPath = isPathDescriptionTool(name);

  // think 工具：结果区改展示思考正文，而不是那句无信息的「已记录思考。」。
  // 出错时（空思考，工具自身回 isError）仍走原结果渲染路径，让错误可见。
  const hasThinkThought = !!thinkThought && !isError;

  // 有结果或进度就展开（结果默认通过 ToolResultDisplay 的 maxLines=3 折叠）
  const hasProgress = status === "executing" && progress !== undefined;
  /**
   * 结果区**有东西可渲染**才算"有结果"（`resultDisplay` 是结果正文字符串）。
   *
   * 不能只判 `!!resultDisplay`：`resultDisplayMode="summary"` 档的正文被置空成 `""`
   * ——那份内容是给模型读的提示词，见 `tool/types.ts` 的 `resultDisplayMode`。
   * 空串是 falsy，所以 `!!""` 恰好为 false、行为看似正确；但**只是巧合**：
   * 一旦上游哪天改成传 `" "` 或 `"\n"`（如未来某工具的正文只剩空白），
   * `!!` 就会判成有结果，画出一条空树枝 `⎿ ` 后面什么都没有——比泄漏提示词更像 bug，
   * 同时 header 的 `resultSummary` 被 `shouldExpandContent ? undefined : ...` 吃掉，
   * 正文与摘要同时消失、卡片彻底失语。
   *
   * 故显式按 `.trim()` 判空，把"看似正确"钉成"确实正确"。
   * hidden 档整条卡片已被 ToolGroupMessage 过滤，走不到这里；
   * summary 档在此退化为"只有 header"的紧凑形态，正是想要的效果。
   */
  const hasResultBody = !!resultDisplay && resultDisplay.trim() !== "";
  const shouldExpandContent = hasResultBody || hasProgress || hasThinkThought;

  // Header 行：bash 工具不显示长命令（移到下方独立区域展示），header 保持简洁。
  // shell 工具 executing 时 header 已有 ToolStatusIndicator 的状态点流转，
  // 不再叠加 TrailingIndicator（避免重复动画，下方命令区域的实时颜色已足够）。
  const header = (
    <Box width={terminalWidth} flexDirection="row">
      <ToolStatusIndicator status={status} />
      <ToolInfo
        name={name}
        // think 与 bash 同理：正文移到下方独立区域后，header 不再重复同一段文字
        // （思考短于 44 列时 header 摘要与正文会一模一样，读起来像卡带）。
        // 但 header 不能退回光秃秃的 `⏺ think`——那正是本次要修的问题；改用用途标签
        // 回答"这一步在干什么"，与下方"记了什么"分工。
        description={
          hasShellCommand
            ? ""
            : hasThinkThought
              ? THINK_HEADER_LABEL
              : description
        }
        status={status}
        emphasis={emphasis}
        // shell 工具的实时输出是多行 tail 快照，塞进单行 header 会被截断——改在命令行下方
        // 以独立多行块展示（见 shellLiveOutputSection）。故 header 只给非 shell 工具（如
        // MCP 工具的单行进度）显示 progressMessage。
        progressMessage={hasShellCommand ? undefined : progressMessage}
        resultSummary={shouldExpandContent ? undefined : resultSummary}
        elapsedMs={elapsedMs}
        // 把真实可用列宽交给 ToolInfo，让 description 按剩余空间收缩，而不是数据层
        // 拍一个与终端无关的固定长度（本次修复的关键穿线：右侧留白得以被利用）。
        // emphasis=high 时 header 尾部还有 TrailingIndicator（` ←`，2 列），要扣掉。
        availableWidth={Math.max(
          0,
          terminalWidth - (emphasis === "high" && !hasShellCommand ? 2 : 0),
        )}
        descriptionIsPath={descriptionIsPath}
      />
      {emphasis === "high" && !hasShellCommand && <TrailingIndicator />}
      <FocusHint name={name} status={status} />
    </Box>
  );

  // 命令截断计算（对标 cc BashTool/UI.tsx）：复用 collapse.ts 的纯函数 truncateShellCommand，
  // 与 CommandMessage 共用同一套两级截断逻辑（先行后字符）。$ 前缀在此拼接。
  const commandDisplay = React.useMemo(() => {
    if (!shellCommand) return null;
    const { text, truncated, summary } = truncateShellCommand(
      shellCommand,
      isFullyExpanded,
    );
    return { text: `$ ${text}`, truncated, summary };
  }, [shellCommand, isFullyExpanded]);

  // Shell 命令展示区域：非展开时截断 + 折叠提示；展开时换行展示完整命令
  // truncate-end：终端宽度不足时从末尾截断并追加 …，避免折行后破坏对齐节奏。
  // 已在 commandDisplay 中按 CMD_MAX_CHARS 预截断，truncate-end 用于兜底窄终端。
  // 2 空格缩进与 header 和结果区的视觉节奏一致
  const shellCommandSection =
    hasShellCommand && commandDisplay ? (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexShrink={0} width={2}>
            <Text> </Text>
          </Box>
          <Box flexGrow={1}>
            <Text
              color={
                status === "executing"
                  ? theme.text.primary
                  : theme.text.secondary
              }
              wrap={commandDisplay.truncated ? "truncate-end" : "wrap"}
            >
              {commandDisplay.text}
            </Text>
          </Box>
        </Box>
        {commandDisplay.truncated && (
          <Box flexDirection="row">
            <Box flexShrink={0} width={2}>
              <Text> </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={theme.text.secondary} dimColor>
                {commandDisplay.summary}
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    ) : null;

  // Shell 实时输出区域：执行中的 bash/shell 工具，把 progressMessage（stdout/stderr 尾部
  // 快照，多行）展示在命令行下方，让 `bun test` 这类长命令不再"卡在无输出"。
  // 仅 executing 态且有进度文本时出现；命令结束后由真实 resultDisplay 接管（progressMessage
  // 不再注入）。灰色 + 2 空格缩进，与命令行、结果区的视觉节奏一致。
  const hasShellLiveOutput =
    hasShellCommand && status === "executing" && !!progressMessage;
  // progressMessage 是多行尾部快照，逐行渲染（每行独立 truncate-end 兜底窄终端）。
  const shellLiveLines = hasShellLiveOutput ? progressMessage!.split("\n") : [];
  const shellLiveOutputSection = hasShellLiveOutput ? (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text color={theme.text.secondary} dimColor>{`  ${TREE_BRANCH} `}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {shellLiveLines.map((line, i) => (
          <Text key={i} color={theme.text.secondary} dimColor wrap="truncate-end">
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  ) : null;

  // 子代理实时进度区：治"过程黑盒"（子代理跑 1m35s，主消息流一个字都没有）。
  //
  // 三档降级对标 cc tools/AgentTool/UI.tsx，但**不嵌套真工具卡片**——那需要把子代理的
  // 每个 content block 永久累积进 messages（cc 的做法），而本项目的进度走轮末即清的
  // 侧信道。档位判定与文案拼装都在 agent-progress-view.ts 的纯函数里（可单测），
  // 这里只负责把结果摆成 Ink 元素。
  const hasAgentProgress = status === "executing" && !!agentProgress;
  const agentTier = hasAgentProgress
    ? selectAgentProgressTier(
        concurrentAgentCount,
        agentProgress!.recentActivities.length,
        terminalHeight,
      )
    : null;
  // 统计行不带任务描述：header 已是 `⏺ sub_agent 核查空壳清理`，进度行再带一遍就是
  // 同一段文字在相邻两行重复（src/ui/CLAUDE.md 禁止）。cc 那边需要带描述是因为它把
  // 多代理进度汇总在一处渲染，本项目每个子代理有自己的卡片，不存在"分不清谁是谁"。
  const agentStatsLine = hasAgentProgress
    ? formatAgentProgressLine(
        {
          agentType: agentProgress!.agentType,
          toolUseCount: agentProgress!.toolUseCount,
          tokenCount: agentProgress!.tokenCount,
          elapsedMs: agentProgress!.elapsedMs,
        },
        formatLargeNumber,
        formatDuration,
      )
    : "";
  // detail 档：统计行 + 逐条最近活动；count / perAgent 档：只有统计行（一行）。
  const agentProgressSection = hasAgentProgress ? (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text color={theme.text.secondary} dimColor>{`  ${TREE_BRANCH} `}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.text.secondary} dimColor wrap="truncate-end">
          {agentStatsLine}
        </Text>
        {agentTier === "detail"
          ? agentProgress!.recentActivities.map((act, i) => (
              <Text key={i} color={theme.text.secondary} dimColor wrap="truncate-end">
                {act}
              </Text>
            ))
          : null}
      </Box>
    </Box>
  ) : null;

  // 无结果、无 shell 命令、无实时输出：紧凑模式只有 header
  // 子代理进度也算"有内容"——否则执行中的 sub_agent 又退回只有一行 header 的黑盒。
  if (!shouldExpandContent && !hasShellCommand && !hasAgentProgress) {
    return header;
  }

  // 展开模式：header + shell 命令（如有）+ 树枝缩进结果区（如有）
  return (
    <Box width={terminalWidth} flexDirection="column">
      {header}
      {shellCommandSection}
      {shellLiveOutputSection}
      {agentProgressSection}
      {shouldExpandContent && (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.text.secondary} dimColor>{`  ${TREE_BRANCH} `}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {hasProgress && (
              <McpProgressIndicator
                progress={progress!}
                total={progressTotal}
                message={progressMessage}
                barWidth={20}
              />
            )}
            {hasThinkThought ? (
              // think：展示思考正文本身（工具结果那句「已记录思考。」无信息量，丢弃）。
              // italic + secondary 与 ThinkingMessage 的思考语言一致——都是"模型在想"，
              // 视觉上应同族，而不是长成普通工具输出。
              // 折叠走 SlicingMaxSizedBox（同步一次成型，Static 安全；见 src/ui/CLAUDE.md L3.3）。
              <SlicingMaxSizedBox
                text={thinkThought!}
                maxLines={thinkMaxLines}
                overflowDirection="bottom"
                maxColumnWidth={Math.max(20, terminalWidth - 4 - THINK_WRAP_PADDING)}
                color={theme.text.secondary}
              />
            ) : (
              <ToolResultDisplay
                resultDisplay={resultDisplay}
                terminalWidth={Math.max(1, terminalWidth - 4)}
                isDiff={isDiff}
                filename={filename}
                structuredPatch={structuredPatch}
                isError={isError}
                renderOutputAsMarkdown={renderOutputAsMarkdown}
                maxLines={3}
                overflowDirection="bottom"
              />
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};
