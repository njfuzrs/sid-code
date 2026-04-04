/**
 * TUI 权限确认组件
 * 显示权限请求详情，支持 y/n/a 三种选择
 * y = 允许本次, n = 拒绝, a = 本次会话内始终允许
 */

import React, { useRef } from "react";
import { Box, Text } from "ink";
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
    <Box flexDirection="column" borderStyle="single" borderColor={theme.status.warning} paddingX={1}>
      <Text color={theme.status.warning} bold>权限请求</Text>
      <Box marginTop={0}>
        <Text>  工具: </Text>
        <Text bold>{request.toolName}</Text>
      </Box>
      {detail && (
        <Box>
          <Text>  参数: </Text>
          <Text dimColor>{String(detail).slice(0, 120)}</Text>
        </Box>
      )}
      {request.reason && (
        <Box>
          <Text>  原因: </Text>
          <Text color={theme.status.warning}>{request.reason}</Text>
        </Box>
      )}
      <Box marginTop={0}>
        <Text color={theme.text.secondary}>
          {" "}[y] 允许  [n] 拒绝  [a] 始终允许
        </Text>
      </Box>
    </Box>
  );
}
