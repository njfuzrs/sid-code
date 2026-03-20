/**
 * 对话框管理器
 *
 * 权限确认对话框注册 Critical 优先级键盘处理器。
 * 当前仅支持权限确认对话框，由 prop 驱动渲染。
 */

import React, { useRef } from "react";
import { Box, Text } from "ink";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { PermissionRequestInfo } from "../App.tsx";
import { getToolSummary } from "../ui-utils.ts";

/** 权限确认对话框 */
function PermissionDialog({ request }: { request: PermissionRequestInfo }) {
  const detail = getToolSummary(request.toolName, request.toolInput);
  // 防止双击：resolve 只执行一次
  const resolvedRef = useRef(false);

  useKeypress(KeypressPriority.Critical, (input, _key) => {
    if (resolvedRef.current) return false;
    const lower = input.toLowerCase();
    if (lower === "y") { resolvedRef.current = true; request.resolve("yes"); return true; }
    if (lower === "n") { resolvedRef.current = true; request.resolve("no"); return true; }
    if (lower === "a") { resolvedRef.current = true; request.resolve("always"); return true; }
    return false;
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>权限请求</Text>
      <Box marginTop={0}>
        <Text>  工具: </Text>
        <Text bold>{request.toolName}</Text>
      </Box>
      <Box>
        <Text>  详情: </Text>
        <Text color="cyan">{detail.length > 60 ? detail.slice(0, 57) + "..." : detail}</Text>
      </Box>
      <Box marginTop={0}>
        <Text color="green" bold> (y)</Text><Text>允许 </Text>
        <Text color="red" bold> (n)</Text><Text>拒绝 </Text>
        <Text color="yellow" bold> (a)</Text><Text>始终允许</Text>
      </Box>
    </Box>
  );
}

/** 对话框渲染器：渲染权限确认对话框 */
export function DialogRenderer({ permissionRequest }: { permissionRequest: PermissionRequestInfo | null }) {
  if (permissionRequest) {
    return <PermissionDialog request={permissionRequest} />;
  }
  return null;
}
