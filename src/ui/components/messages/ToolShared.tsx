/**
 * 工具状态指示器共享组件
 *
 * 提供工具执行状态的图标、颜色、信息展示等共享逻辑。
 * 参考 gemini-cli/packages/cli/src/ui/components/messages/ToolShared.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { theme } from "../../semantic-colors.ts";

export const STATUS_INDICATOR_WIDTH = 3;

/** 工具执行状态 */
export type ToolCallStatus = "pending" | "executing" | "success" | "error" | "cancelled";

/** 文本强调级别 */
export type TextEmphasis = "high" | "medium" | "low";

/** 工具状态图标常量 */
const TOOL_STATUS_ICONS = {
  PENDING: "○ ",
  SUCCESS: "✓ ",
  ERROR: "✗ ",
  CANCELLED: "⊘ ",
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
        <Spinner label=" " />
      )}
      {status === "success" && (
        <Text color={theme.status.success}>{TOOL_STATUS_ICONS.SUCCESS}</Text>
      )}
      {status === "error" && (
        <Text color={theme.status.error} bold>{TOOL_STATUS_ICONS.ERROR}</Text>
      )}
      {status === "cancelled" && (
        <Text color={theme.status.warning} bold>{TOOL_STATUS_ICONS.CANCELLED}</Text>
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
