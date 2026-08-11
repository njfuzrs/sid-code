/**
 * 工具状态指示器共享组件
 *
 * 视觉语言对标 claude-code：状态用单一圆点字形 ⏺，仅靠**颜色**区分状态，
 * 不再用 ✓ ⟳ ✕ ⋅ ❌ 等粗细不一的多字形。结果区靠 ⎿ 树枝缩进，不画盒子。
 *
 * 状态 → 颜色：
 * - Pending    → dim 灰（排队中）
 * - Executing  → 品牌蓝（进行中）
 * - Success    → success 绿
 * - Canceled   → dim + 删除线
 * - Error      → error 红
 */

import React from "react";
import Box from "../../../ink/components/Box.tsx";
import Text from "../../../ink/components/Text.tsx";
import { theme } from "../../semantic-colors.ts";
import { BULLET, ARROW_TRAILING } from "../../constants/figures.ts";
import { formatDuration } from "../../utils/format-duration.ts";
import { fitPathToWidth, fitTextToWidth } from "../../utils/path-display.ts";
import { stringWidth } from "../../../ink/stringWidth.ts";

export const STATUS_INDICATOR_WIDTH = 2;

/** 工具执行状态 */
export type ToolCallStatus = "pending" | "executing" | "success" | "error" | "cancelled";

/** 文本强调级别 */
export type TextEmphasis = "high" | "medium" | "low";

/** 工具状态指示器：统一圆点字形，仅颜色区分状态（对标 cc） */
export const ToolStatusIndicator: React.FC<{
  status: ToolCallStatus;
}> = ({ status }) => {
  return (
    <Box minWidth={STATUS_INDICATOR_WIDTH}>
      {status === "pending" && (
        <Text color={theme.text.secondary}>{BULLET}</Text>
      )}
      {status === "executing" && (
        <Text color={theme.ui.active}>{BULLET}</Text>
      )}
      {status === "success" && (
        <Text color={theme.status.success}>{BULLET}</Text>
      )}
      {status === "cancelled" && (
        <Text color={theme.text.secondary} strikethrough>{BULLET}</Text>
      )}
      {status === "error" && (
        <Text color={theme.status.error} bold>{BULLET}</Text>
      )}
    </Box>
  );
};

/**
 * header 里除 description 之外的固定开销（列）：状态点占位 + 工具名后的一个空格。
 * 用于反推 description 能吃到的列宽预算。
 */
const HEADER_FIXED_OVERHEAD = STATUS_INDICATOR_WIDTH + 1;

/** description 至少保留的列宽——低于这个数就没有信息量了，宁可让终端自己硬截。 */
const MIN_DESCRIPTION_COLS = 12;

/**
 * 工具信息展示（header 单行）。
 *
 * **宽度分配**是这个组件的核心职责（本次修复的落点）：header 是一行，装不下就要收缩，
 * 关键是「按真实可用列宽收缩」而不是数据层拍一个固定长度。收缩顺序体现信息优先级——
 * 工具名 / 耗时 / 结果摘要都短且固定，先给它们，剩下的全部留给 description；
 * description 是路径时从**头部**省略目录（保住文件名），是文本时从尾部省略。
 *
 * 此前这里对 description 不做任何宽度处理，`wrap="truncate"` 让终端在行尾硬砍：
 * 数据层已经把路径砍到 50 码点（与终端宽度无关），于是宽终端右侧大片留白闲置，
 * 而被砍掉的恰好是唯一有区分度的文件名。
 */
export const ToolInfo: React.FC<{
  name: string;
  description: string;
  status: ToolCallStatus;
  emphasis?: TextEmphasis;
  progressMessage?: string;
  /** 结果摘要（成功时显示在 description 后面） */
  resultSummary?: string;
  /** 工具执行耗时（毫秒），完成态时显示在工具名后。缺省时不显示 */
  elapsedMs?: number;
  /**
   * header 行可用总列宽。传入后 description 会按真实剩余空间收缩（宽终端多显示、
   * 窄终端才省略）；缺省时退回旧行为（交给 `wrap="truncate"` 硬截），保证
   * 未穿线的调用方不炸。
   */
  availableWidth?: number;
  /**
   * description 是否是文件路径。路径从**头部**按目录段省略以保住文件名
   * （`…/todo/x.md`），普通文本则从尾部省略。
   */
  descriptionIsPath?: boolean;
}> = ({
  name,
  description,
  status,
  emphasis = "medium",
  progressMessage,
  resultSummary,
  elapsedMs,
  availableWidth,
  descriptionIsPath = false,
}) => {
  const nameColor = emphasis === "low" ? theme.text.secondary : theme.text.primary;
  const isDone = status === "success" || status === "error";

  const durationText =
    isDone && elapsedMs !== undefined ? ` (${formatDuration(elapsedMs)})` : "";
  const summaryText = resultSummary && isDone ? ` — ${resultSummary}` : "";
  const progressText =
    progressMessage && status === "executing" ? ` ${progressMessage}` : "";

  // description 的列宽预算 = 总宽 - 状态点 - 工具名 - 耗时 - 结果摘要 - 进度
  // 预算算不出来（未传 availableWidth）或过窄时不主动收缩，交给终端硬截兜底。
  const fittedDescription = React.useMemo(() => {
    if (!description || availableWidth === undefined) return description;
    const budget =
      availableWidth -
      HEADER_FIXED_OVERHEAD -
      stringWidth(name) -
      stringWidth(durationText) -
      stringWidth(summaryText) -
      stringWidth(progressText);
    if (budget < MIN_DESCRIPTION_COLS) return description;
    return descriptionIsPath
      ? fitPathToWidth(description, budget)
      : fitTextToWidth(description, budget);
  }, [
    description,
    availableWidth,
    name,
    durationText,
    summaryText,
    progressText,
    descriptionIsPath,
  ]);

  return (
    <Box overflow="hidden" height={1} flexGrow={1} flexShrink={1}>
      <Text strikethrough={status === "cancelled"} wrap="truncate">
        <Text color={nameColor} bold>{name}</Text>
        {fittedDescription ? (
          <>
            {" "}
            <Text color={theme.text.secondary}>{fittedDescription}</Text>
          </>
        ) : null}
        {durationText ? <Text>{durationText}</Text> : null}
        {summaryText ? <Text>{summaryText}</Text> : null}
        {progressText ? (
          <Text color={theme.text.accent} italic>{progressText}</Text>
        ) : null}
      </Text>
    </Box>
  );
};

/** 执行中尾部指示器（← 箭头） */
export const TrailingIndicator: React.FC = () => (
  <Text color={theme.text.primary} wrap="truncate">
    {` ${ARROW_TRAILING}`}
  </Text>
);

/** MCP 进度条指示器 */
export const McpProgressIndicator: React.FC<{
  progress: number;
  total?: number;
  message?: string;
  barWidth: number;
}> = ({ progress, total, message, barWidth }) => {
  const percentage =
    total && total > 0
      ? Math.min(100, Math.round((progress / total) * 100))
      : null;

  let rawFilled: number;
  if (total && total > 0) {
    rawFilled = Math.round((progress / total) * barWidth);
  } else {
    rawFilled = Math.floor(progress) % (barWidth + 1);
  }

  const filled = Math.max(0, Math.min(Number.isFinite(rawFilled) ? rawFilled : 0, barWidth));
  const empty = Math.max(0, barWidth - filled);
  const progressBar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.text.accent}>
          {progressBar} {percentage !== null ? `${percentage}%` : `${progress}`}
        </Text>
      </Box>
      {message && (
        <Text color={theme.text.secondary} wrap="truncate">
          {message}
        </Text>
      )}
    </Box>
  );
};

/** 判断是否为 Shell/Bash 工具 */
export function isShellTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "bash" || lower === "shell" || lower === "execute_command";
}

/**
 * 判断工具的 header description 是否是**文件路径**。
 *
 * 决定收缩方向：路径的信息密度在尾部（文件名），要从头部省略目录段；
 * 命令 / prompt 这类文本的信息密度在头部，从尾部省略。判错方向的后果就是本次要修的
 * bug——保住了每行都一样的 `/Users/…/sid-code/` 前缀，砍掉了唯一有区分度的文件名。
 *
 * 与 `ui-utils.ts` 的 `getToolSummary` 保持对应：那里对 read/edit/write 走
 * `shortenPathForDisplay`，这里就要对同一批工具报 true。
 */
export function isPathDescriptionTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "read" || lower === "edit" || lower === "write";
}

/**
 * Shell 工具焦点提示
 *
 * 当 Bash 工具正在执行时，显示提示信息。
 * 参考 gemini-cli FocusHint 组件（简化版，sid-code 暂无嵌入式 Shell 焦点系统）
 */
export const FocusHint: React.FC<{
  name: string;
  status: ToolCallStatus;
}> = ({ name, status }) => {
  if (!isShellTool(name) || status !== "executing") {
    return null;
  }

  return (
    <Box marginLeft={1} flexShrink={0}>
      <Text color={theme.ui.active}>
        (执行中…)
      </Text>
    </Box>
  );
};
