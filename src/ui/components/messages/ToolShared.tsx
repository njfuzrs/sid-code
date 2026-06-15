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
 * - Confirming → warning 黄
 * - Canceled   → dim + 删除线
 * - Error      → error 红
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";
import { BULLET, ARROW_TRAILING } from "../../constants/figures.ts";

export const STATUS_INDICATOR_WIDTH = 2;

/** 工具执行状态 */
export type ToolCallStatus = "pending" | "executing" | "success" | "error" | "cancelled" | "confirming";

/** 文本强调级别 */
export type TextEmphasis = "high" | "medium" | "low";

/** 工具状态指示器：统一圆点字形，仅颜色区分状态（对标 cc） */
export const ToolStatusIndicator: React.FC<{
  status: ToolCallStatus;
}> = ({ status }) => {
  return (
    <Box minWidth={STATUS_INDICATOR_WIDTH}>
      {status === "pending" && (
        <Text color={theme.text.secondary} dimColor>{BULLET}</Text>
      )}
      {status === "executing" && (
        <Text color={theme.ui.active}>{BULLET}</Text>
      )}
      {status === "success" && (
        <Text color={theme.status.success}>{BULLET}</Text>
      )}
      {status === "confirming" && (
        <Text color={theme.status.warning}>{BULLET}</Text>
      )}
      {status === "cancelled" && (
        <Text color={theme.text.secondary} dimColor strikethrough>{BULLET}</Text>
      )}
      {status === "error" && (
        <Text color={theme.status.error} bold>{BULLET}</Text>
      )}
    </Box>
  );
};

/** 工具信息展示 */
export const ToolInfo: React.FC<{
  name: string;
  description: string;
  status: ToolCallStatus;
  emphasis?: TextEmphasis;
  progressMessage?: string;
  /** 结果摘要（成功时显示在 description 后面） */
  resultSummary?: string;
}> = ({ name, description, status, emphasis = "medium", progressMessage, resultSummary }) => {
  const nameColor = emphasis === "low" ? theme.text.secondary : theme.text.primary;

  return (
    <Box overflow="hidden" height={1} flexGrow={1} flexShrink={1}>
      <Text strikethrough={status === "cancelled"} wrap="truncate">
        <Text color={nameColor} bold>{name}</Text>
        {description ? (
          <>
            {" "}
            <Text color={theme.text.secondary}>{description}</Text>
          </>
        ) : null}
        {resultSummary && (status === "success" || status === "error") ? (
          <>
            <Text dimColor>{" — "}</Text>
            <Text dimColor>{resultSummary}</Text>
          </>
        ) : null}
        {progressMessage && status === "executing" ? (
          <>
            {" "}
            <Text color={theme.text.accent} italic>{progressMessage}</Text>
          </>
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
      <Text color={theme.ui.active} dimColor>
        (执行中…)
      </Text>
    </Box>
  );
};
