/**
 * 工具状态指示器共享组件
 *
 * 提供工具执行状态的图标、颜色、信息展示等共享逻辑。
 * 参考 gemini-cli/packages/cli/src/ui/components/messages/ToolShared.tsx
 *
 * P1 增强：对齐 gemini-cli 的状态图标
 * - Pending    → ⋅ (success green)
 * - Executing  → ⟳ (spinner)
 * - Success    → ✓ (success green)
 * - Confirming → ❌ (warning)
 * - Canceled   → ✗ (strikethrough)
 * - Error      → ✕ (error red)
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../semantic-colors.ts";

export const STATUS_INDICATOR_WIDTH = 3;

/** 工具执行状态 */
export type ToolCallStatus = "pending" | "executing" | "success" | "error" | "cancelled" | "confirming";

/** 文本强调级别 */
export type TextEmphasis = "high" | "medium" | "low";

/** 工具状态图标常量（对齐 gemini-cli） */
const TOOL_STATUS_ICONS = {
  PENDING: "⋅ ",      // gemini-cli: ⋅ (success green)
  EXECUTING: "⟳ ",    // gemini-cli: ⟳ (spinner)
  SUCCESS: "✓ ",      // gemini-cli: ✓ (success green)
  CONFIRMING: "❌ ",  // gemini-cli: ❌ (warning)
  CANCELLED: "✗ ",    // gemini-cli: ✗ (strikethrough)
  ERROR: "✕ ",        // gemini-cli: ✕ (error red)
};

/** 工具状态指示器 */
export const ToolStatusIndicator: React.FC<{
  status: ToolCallStatus;
}> = ({ status }) => {
  return (
    <Box minWidth={STATUS_INDICATOR_WIDTH}>
      {status === "pending" && (
        <Text color={theme.status.success}>{TOOL_STATUS_ICONS.PENDING}</Text>
      )}
      {status === "executing" && (
        <Text color={theme.ui.active}>{TOOL_STATUS_ICONS.EXECUTING}</Text>
      )}
      {status === "success" && (
        <Text color={theme.status.success}>{TOOL_STATUS_ICONS.SUCCESS}</Text>
      )}
      {status === "confirming" && (
        <Text color={theme.status.warning}>{TOOL_STATUS_ICONS.CONFIRMING}</Text>
      )}
      {status === "cancelled" && (
        <Text color={theme.text.secondary} strikethrough>{TOOL_STATUS_ICONS.CANCELLED}</Text>
      )}
      {status === "error" && (
        <Text color={theme.status.error} bold>{TOOL_STATUS_ICONS.ERROR}</Text>
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
    {" "}←
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
        (执行中...)
      </Text>
    </Box>
  );
};
