/**
 * 对话框管理器
 *
 * 按优先级管理多个对话框，只渲染最高优先级的活跃对话框。
 * 权限确认对话框注册 Critical 优先级键盘处理器。
 */

import React, { createContext, useContext, useState, useCallback } from "react";
import { Box, Text } from "ink";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { PermissionRequestInfo } from "../App.tsx";

/** 对话框类型优先级 */
const DIALOG_PRIORITY = {
  toolConfirmation: 200,
  askUser: 100,
} as const;

type DialogType = keyof typeof DIALOG_PRIORITY;

interface DialogState {
  type: DialogType;
  props: any;
}

interface DialogManagerContextValue {
  showDialog: (type: DialogType, props: any) => void;
  hideDialog: (type: DialogType) => void;
  hasActiveDialog: () => boolean;
}

const DialogManagerCtx = createContext<DialogManagerContextValue | null>(null);

export function useDialogManager() {
  const ctx = useContext(DialogManagerCtx);
  if (!ctx) throw new Error("useDialogManager 必须在 DialogManagerProvider 内使用");
  return ctx;
}

/** 格式化工具输入的关键信息 */
function formatToolDetail(toolName: string, input: unknown): string {
  const lower = toolName.toLowerCase();
  if (lower === "bash") {
    return (input as any)?.command || JSON.stringify(input).slice(0, 80);
  } else if (lower === "write" || lower === "edit" || lower === "read") {
    return (input as any)?.file_path || (input as any)?.filePath || (input as any)?.path || "";
  } else if (lower === "grep") {
    return `pattern: ${(input as any)?.pattern || ""}`;
  } else if (lower === "glob") {
    return `pattern: ${(input as any)?.pattern || ""}`;
  }
  return JSON.stringify(input).slice(0, 80);
}

/** 权限确认对话框 */
function PermissionDialog({ request }: { request: PermissionRequestInfo }) {
  const detail = formatToolDetail(request.toolName, request.toolInput);

  // 注册 Critical 优先级键盘处理器
  useKeypress(KeypressPriority.Critical, (input, _key) => {
    const lower = input.toLowerCase();
    if (lower === "y") { request.resolve("yes"); return true; }
    if (lower === "n") { request.resolve("no"); return true; }
    if (lower === "a") { request.resolve("always"); return true; }
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

export function DialogManagerProvider({ children }: { children: React.ReactNode }) {
  const [dialogs, setDialogs] = useState<Map<DialogType, DialogState>>(new Map());

  const showDialog = useCallback((type: DialogType, props: any) => {
    setDialogs(prev => {
      const next = new Map(prev);
      next.set(type, { type, props });
      return next;
    });
  }, []);

  const hideDialog = useCallback((type: DialogType) => {
    setDialogs(prev => {
      const next = new Map(prev);
      next.delete(type);
      return next;
    });
  }, []);

  const hasActiveDialog = useCallback(() => {
    return dialogs.size > 0;
  }, [dialogs]);

  return (
    <DialogManagerCtx.Provider value={{ showDialog, hideDialog, hasActiveDialog }}>
      {children}
    </DialogManagerCtx.Provider>
  );
}

/** 对话框渲染器：只渲染最高优先级的活跃对话框 */
export function DialogRenderer({ permissionRequest }: { permissionRequest: PermissionRequestInfo | null }) {
  if (permissionRequest) {
    return <PermissionDialog request={permissionRequest} />;
  }
  return null;
}
