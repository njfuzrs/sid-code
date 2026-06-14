/**
 * TUI 权限确认组件
 * 显示权限请求详情，支持 y/n/a 三种选择
 * y = 允许本次, n = 拒绝, a = 本次会话内始终允许
 *
 * 视觉语言：圆角边框（对齐输入框 round 风格），按键字母用品牌色高亮，
 * 操作项分隔清晰，让高频决策点一眼可辨。
 */

import React, { useRef } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import { theme } from "../semantic-colors.ts";

/** 权限确认请求信息 */
export interface PermissionPromptRequest {
  toolName: string;
  toolInput: unknown;
  description?: string;
  reason?: string;
  resolve: (result: "yes" | "no" | "always") => void;
}

/** 单个操作项：高亮按键 + 说明 */
const ActionKey: React.FC<{ keyLabel: string; desc: string; color: string }> = ({
  keyLabel,
  desc,
  color,
}) => (
  <Text>
    <Text color={color} bold>{keyLabel}</Text>
    <Text color={theme.text.secondary}>{` ${desc}`}</Text>
  </Text>
);

/** 权限确认组件 */
export function PermissionPrompt({ request }: { request: PermissionPromptRequest }) {
  const resolvedRef = useRef(false);

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;
    if (!key.insertable) return false;

    const lower = key.name;
    if (lower === "y") {
      resolvedRef.current = true;
      request.resolve("yes");
      return true;
    }
    if (lower === "n") {
      resolvedRef.current = true;
      request.resolve("no");
      return true;
    }
    if (lower === "a") {
      resolvedRef.current = true;
      request.resolve("always");
      return true;
    }
    return false;
  });

  // 提取关键参数用于显示
  const input = request.toolInput as any;
  const detail = input?.file_path || input?.command || input?.pattern || "";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
    >
      {/* 标题行：警告色圆点 + 标题 */}
      <Box>
        <Text color={theme.status.warning} bold>{"● 权限请求"}</Text>
      </Box>

      {/* 详情：工具名高亮，参数/原因柔和 */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.text.secondary}>{"工具  "}</Text>
          <Text color={theme.text.primary} bold>{request.toolName}</Text>
        </Box>
        {detail && (
          <Box>
            <Text color={theme.text.secondary}>{"参数  "}</Text>
            <Text color={theme.text.secondary} dimColor>{String(detail).slice(0, 120)}</Text>
          </Box>
        )}
        {request.reason && (
          <Box>
            <Text color={theme.text.secondary}>{"原因  "}</Text>
            <Text color={theme.status.warning}>{request.reason}</Text>
          </Box>
        )}
      </Box>

      {/* 操作行：按键字母高亮，绿/红/蓝区分语义 */}
      <Box marginTop={1} gap={2}>
        <ActionKey keyLabel="y" desc="允许" color={theme.status.success} />
        <ActionKey keyLabel="n" desc="拒绝" color={theme.status.error} />
        <ActionKey keyLabel="a" desc="始终允许" color={theme.ui.active} />
      </Box>
    </Box>
  );
}
