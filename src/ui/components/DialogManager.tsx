/**
 * 对话框管理器
 *
 * 按优先级管理多个对话框，只渲染最高优先级的活跃对话框。
 * 权限确认对话框注册 Critical 优先级键盘处理器。
 */

import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { PermissionRequestInfo } from "../App.tsx";
import { getToolSummary } from "../ui-utils.ts";

/** 对话框类型及其优先级 */
const DIALOG_PRIORITY = {
  toolConfirmation: 200,
  askUser: 100,
} as const;

type DialogType = keyof typeof DIALOG_PRIORITY;

/** 类型安全的对话框 props 映射 */
interface DialogPropsMap {
  toolConfirmation: { request: PermissionRequestInfo };
  askUser: { question: string; resolve: (answer: string) => void };
}

interface DialogState<T extends DialogType = DialogType> {
  type: T;
  props: DialogPropsMap[T];
}

interface DialogManagerContextValue {
  showDialog: <T extends DialogType>(type: T, props: DialogPropsMap[T]) => void;
  hideDialog: (type: DialogType) => void;
  /** 当前是否有活跃对话框 */
  hasActiveDialog: boolean;
}

const DialogManagerCtx = createContext<DialogManagerContextValue | null>(null);

export function useDialogManager() {
  const ctx = useContext(DialogManagerCtx);
  if (!ctx) throw new Error("useDialogManager 必须在 DialogManagerProvider 内使用");
  return ctx;
}

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

export function DialogManagerProvider({ children }: { children: React.ReactNode }) {
  const [dialogs, setDialogs] = useState<Map<DialogType, DialogState>>(new Map());

  const showDialog = useCallback(<T extends DialogType>(type: T, props: DialogPropsMap[T]) => {
    setDialogs(prev => {
      const next = new Map(prev);
      next.set(type, { type, props } as DialogState);
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

  const hasActiveDialog = dialogs.size > 0;

  return (
    <DialogManagerCtx.Provider value={{ showDialog, hideDialog, hasActiveDialog }}>
      {children}
    </DialogManagerCtx.Provider>
  );
}

/** 对话框渲染器：渲染最高优先级的活跃对话框 */
export function DialogRenderer({ permissionRequest }: { permissionRequest: PermissionRequestInfo | null }) {
  if (permissionRequest) {
    return <PermissionDialog request={permissionRequest} />;
  }
  return null;
}
