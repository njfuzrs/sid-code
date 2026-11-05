/**
 * Toast 提示显示组件
 * 显示瞬态消息（Ctrl+C 提示、Escape 提示、溢出提示等）
 */

import React from "react";
import { Box, Text } from "../render-port/components.ts";
import { useHeldRows } from "../hooks/useHeldRows.ts";
import { theme } from "../semantic-colors.ts";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { TransientMessageType } from "../contexts/UIStateContext.tsx";

export function shouldShowToast(uiState: ReturnType<typeof useUIState>): boolean {
  return (
    Boolean(uiState.transientMessage) || uiState.showEscapePrompt || uiState.showIsExpandableHint
  );
}

/**
 * Toast 行出现过就占住一行到下一轮开始（useHeldRows）：Esc / Ctrl+O 提示几秒后自己消失，
 * 消失那一帧若让主屏帧变矮，就是一次整帧重画全部历史（见 hooks/useHeldRows.ts）。
 */
export const ToastDisplay: React.FC<{ busy?: boolean }> = ({ busy = false }) => {
  const uiState = useUIState();
  const content = toastContent(uiState);
  const rows = useHeldRows(content ? 1 : 0, busy, { releaseWhenIdle: true });
  if (rows === 0) return null;
  return <Box minHeight={rows}>{content}</Box>;
};

function toastContent(uiState: ReturnType<typeof useUIState>): React.ReactNode {
  // Ctrl+C/D 退出提示已由 ExitWarning 组件独立处理

  if (
    uiState.transientMessage?.type === TransientMessageType.Warning &&
    uiState.transientMessage.text
  ) {
    return <Text color={theme.status.warning}>{uiState.transientMessage.text}</Text>;
  }

  if (uiState.showEscapePrompt) {
    return <Text color={theme.text.secondary}>再次按 Esc 清空输入</Text>;
  }

  if (
    uiState.transientMessage?.type === TransientMessageType.Hint &&
    uiState.transientMessage.text
  ) {
    return <Text color={theme.text.secondary}>{uiState.transientMessage.text}</Text>;
  }

  if (
    uiState.transientMessage?.type === TransientMessageType.Info &&
    uiState.transientMessage.text
  ) {
    // L1.2：`theme.status` 没有 info 档，需要「信息蓝」时用品牌色 ui.active。
    // Hint 走 text.secondary 是因为它是"顺带一提"，Info 是"告知一件事"，用品牌蓝点睛。
    return <Text color={theme.ui.active}>{uiState.transientMessage.text}</Text>;
  }

  if (uiState.showIsExpandableHint) {
    // TO4：阶梯式展开提示——按当前级别提示下一步动作。
    const action =
      uiState.expandLevel === 0 ? "展开" : uiState.expandLevel === 1 ? "全部展开" : "折叠";
    return <Text color={theme.text.accent}>按 Ctrl+O {action}折叠内容（工具结果 + 思考）</Text>;
  }

  return null;
}
