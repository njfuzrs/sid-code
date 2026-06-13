/**
 * Toast 提示显示组件
 * 显示瞬态消息（Ctrl+C 提示、Escape 提示、溢出提示等）
 */

import React from 'react';
import Text from "../../ink/components/Text.js";
import { theme } from '../semantic-colors.ts';
import { useUIState } from '../contexts/UIStateContext.tsx';
import { TransientMessageType } from '../contexts/UIStateContext.tsx';

export function shouldShowToast(uiState: ReturnType<typeof useUIState>): boolean {
  return (
    Boolean(uiState.transientMessage) ||
    uiState.showEscapePrompt ||
    uiState.showIsExpandableHint
  );
}

export const ToastDisplay: React.FC = () => {
  const uiState = useUIState();

  // Ctrl+C/D 退出提示已由 ExitWarning 组件独立处理

  if (
    uiState.transientMessage?.type === TransientMessageType.Warning &&
    uiState.transientMessage.text
  ) {
    return (
      <Text color={theme.status.warning}>{uiState.transientMessage.text}</Text>
    );
  }

  if (uiState.showEscapePrompt) {
    return (
      <Text color={theme.text.secondary}>
        再次按 Esc 清空输入
      </Text>
    );
  }

  if (
    uiState.transientMessage?.type === TransientMessageType.Hint &&
    uiState.transientMessage.text
  ) {
    return (
      <Text color={theme.text.secondary}>{uiState.transientMessage.text}</Text>
    );
  }

  if (uiState.showIsExpandableHint) {
    // TO4：阶梯式展开提示——按当前级别提示下一步动作。
    const action =
      uiState.expandLevel === 0
        ? '显示更多'
        : uiState.expandLevel === 1
          ? '全部展开'
          : '折叠';
    return (
      <Text color={theme.text.accent}>
        按 Ctrl+O {action}最后一条回复的行数
      </Text>
    );
  }

  return null;
};
