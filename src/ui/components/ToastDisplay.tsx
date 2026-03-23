/**
 * Toast 提示显示组件
 * 显示瞬态消息（Ctrl+C 提示、Escape 提示、溢出提示等）
 */

import React from 'react';
import { Text } from 'ink';
import { theme } from '../semantic-colors.ts';
import { useUIState } from '../contexts/UIStateContext.tsx';
import { TransientMessageType } from '../contexts/UIStateContext.tsx';

export function shouldShowToast(uiState: ReturnType<typeof useUIState>): boolean {
  return (
    uiState.ctrlCPressedOnce ||
    Boolean(uiState.transientMessage) ||
    uiState.ctrlDPressedOnce ||
    uiState.showEscapePrompt ||
    uiState.showIsExpandableHint
  );
}

export const ToastDisplay: React.FC = () => {
  const uiState = useUIState();

  if (uiState.ctrlCPressedOnce) {
    return (
      <Text color={theme.status.warning}>再次按 Ctrl+C 退出</Text>
    );
  }

  if (
    uiState.transientMessage?.type === TransientMessageType.Warning &&
    uiState.transientMessage.text
  ) {
    return (
      <Text color={theme.status.warning}>{uiState.transientMessage.text}</Text>
    );
  }

  if (uiState.ctrlDPressedOnce) {
    return (
      <Text color={theme.status.warning}>再次按 Ctrl+D 退出</Text>
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
    const action = uiState.constrainHeight ? '显示更多' : '折叠';
    return (
      <Text color={theme.text.accent}>
        按 Ctrl+O {action}最后一条回复的行数
      </Text>
    );
  }

  return null;
};
