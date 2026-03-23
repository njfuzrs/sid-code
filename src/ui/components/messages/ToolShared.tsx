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
}> = ({ name, description, status, emphasis = "medium" }) => {
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
      </Text>
    </Box>
  );
};
