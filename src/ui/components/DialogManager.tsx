/**
 * 对话框管理器
 *
 * 权限确认对话框注册 Critical 优先级键盘处理器。
 * 支持：权限确认对话框、Shell 命令确认对话框、设置对话框、模型对话框、主题对话框。
 */

import React, { useRef } from "react";
import { Box, Text } from "ink";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { PermissionRequestInfo, ShellConfirmRequestInfo } from "../App.tsx";
import { getToolSummary } from "../ui-utils.ts";
import { theme } from "../semantic-colors.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { ModelDialog } from "./ModelDialog.tsx";
import { ThemeDialog } from "./ThemeDialog.tsx";

/** 权限确认对话框 */
function PermissionDialog({ request }: { request: PermissionRequestInfo }) {
  const detail = getToolSummary(request.toolName, request.toolInput);
  const resolvedRef = useRef(false);

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;
    if (!key.insertable) return false;
    const lower = key.name;
    if (lower === "y") { resolvedRef.current = true; request.resolve("yes"); return true; }
    if (lower === "n") { resolvedRef.current = true; request.resolve("no"); return true; }
    if (lower === "a") { resolvedRef.current = true; request.resolve("always"); return true; }
    return false;
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.status.warning} paddingX={1}>
      <Text color={theme.status.warning} bold>权限请求</Text>
      <Box marginTop={0}>
        <Text>  工具: </Text>
        <Text bold>{request.toolName}</Text>
      </Box>
      <Box>
        <Text>  详情: </Text>
        <Text color={theme.ui.active}>{detail.length > 60 ? detail.slice(0, 57) + "..." : detail}</Text>
      </Box>
      <Box marginTop={0}>
        <Text color={theme.status.success} bold> (y)</Text><Text>允许 </Text>
        <Text color={theme.status.error} bold> (n)</Text><Text>拒绝 </Text>
        <Text color={theme.status.warning} bold> (a)</Text><Text>始终允许</Text>
      </Box>
    </Box>
  );
}

/** Shell 命令确认对话框 */
function ShellConfirmDialog({ request }: { request: ShellConfirmRequestInfo }) {
  const resolvedRef = useRef(false);

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;
    if (!key.insertable) return false;
    const lower = key.name;
    if (lower === "y") { resolvedRef.current = true; request.resolve(true); return true; }
    if (lower === "n") { resolvedRef.current = true; request.resolve(false); return true; }
    return false;
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.text.accent} paddingX={1}>
      <Text color={theme.text.accent} bold>Shell 命令确认</Text>
      <Text dimColor>自定义命令将执行以下 Shell 命令：</Text>
      {request.commands.map((cmd, i) => (
        <Box key={i} marginLeft={2}>
          <Text color={theme.ui.active}>$ </Text>
          <Text>{cmd}</Text>
        </Box>
      ))}
      <Box marginTop={0}>
        <Text color={theme.status.success} bold> (y)</Text><Text>确认执行 </Text>
        <Text color={theme.status.error} bold> (n)</Text><Text>取消</Text>
      </Box>
    </Box>
  );
}

/** 对话框渲染器：渲染权限确认或 Shell 确认对话框 */
export function DialogRenderer({
  permissionRequest,
  shellConfirmRequest,
}: {
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
}) {
  if (permissionRequest) {
    return <PermissionDialog request={permissionRequest} />;
  }
  if (shellConfirmRequest) {
    return <ShellConfirmDialog request={shellConfirmRequest} />;
  }
  return null;
}
