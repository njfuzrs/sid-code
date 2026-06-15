/**
 * 对话框管理器
 *
 * 权限确认对话框注册 Critical 优先级键盘处理器。
 * 支持：权限确认对话框、Shell 命令确认对话框、设置对话框、模型对话框、主题对话框。
 */

import React, { useRef } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo } from "../App.tsx";
import { getToolSummary } from "../ui-utils.ts";
import { theme } from "../semantic-colors.ts";
import { BULLET, PLAN_REVIEW } from "../constants/figures.ts";
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
    <Box flexDirection="column" borderStyle="round" borderColor={theme.status.warning} paddingX={1}>
      <Text color={theme.status.warning} bold>{BULLET} 权限请求</Text>
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
    <Box flexDirection="column" borderStyle="round" borderColor={theme.text.accent} paddingX={1}>
      <Text color={theme.text.accent} bold>{BULLET} Shell 命令确认</Text>
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

/** Plan Mode 审批对话框（轻量版：计划内容已在上方消息区域渲染，底部只显示操作栏） */
function PlanApprovalDialog({ request }: { request: PlanApprovalRequestInfo }) {
  const resolvedRef = useRef(false);

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;
    if (!key.insertable) return false;
    const lower = key.name;
    if (lower === "y") { resolvedRef.current = true; request.resolve("approve"); return true; }
    if (lower === "n") { resolvedRef.current = true; request.resolve("reject"); return true; }
    return false;
  });

  const lineCount = request.planContent.split("\n").length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.text.accent} paddingX={1}>
      <Text color={theme.text.accent} bold>{PLAN_REVIEW} 计划审批</Text>
      <Text dimColor>文件: {request.planFilePath} ({lineCount} 行)</Text>
      <Text dimColor>计划内容已显示在上方消息区域，可滚动查看</Text>
      <Box marginTop={0}>
        <Text color={theme.status.success} bold> (y)</Text><Text>批准并执行 </Text>
        <Text color={theme.status.error} bold> (n)</Text><Text>拒绝并修改</Text>
      </Box>
    </Box>
  );
}

/** 对话框渲染器：渲染权限确认、Shell 确认或 Plan 审批对话框 */
export function DialogRenderer({
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
}: {
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
}) {
  if (permissionRequest) {
    return <PermissionDialog request={permissionRequest} />;
  }
  if (shellConfirmRequest) {
    return <ShellConfirmDialog request={shellConfirmRequest} />;
  }
  if (planApprovalRequest) {
    return <PlanApprovalDialog request={planApprovalRequest} />;
  }
  return null;
}
