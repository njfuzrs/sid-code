/**
 * 通知组件
 *
 * 显示更新通知、启动警告、初始化错误等持久性通知。
 * 参考 gemini-cli/packages/cli/src/ui/components/Notifications.tsx
 *
 * 增强：
 * - 支持 startupWarnings（按优先级过滤）
 * - 支持 initError（流式响应时隐藏）
 * - 按任意键关闭启动警告
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.ts';
import { useUIState } from '../contexts/UIStateContext.tsx';
import { useStreamingState, StreamingState } from '../contexts/StreamingContext.tsx';
import { useKeypress, KeypressPriority } from '../contexts/KeypressContext.tsx';

/** 启动警告 */
export interface StartupWarning {
  id: string;
  message: string;
}

interface UpdateNotificationProps {
  message: string;
}

const UpdateNotification: React.FC<UpdateNotificationProps> = ({ message }) => (
  <Box
    borderStyle="round"
    borderColor={theme.status.warning}
    paddingX={1}
    marginY={1}
  >
    <Text color={theme.status.warning}>{message}</Text>
  </Box>
);

interface NotificationsProps {
  /** 启动警告列表 */
  startupWarnings?: StartupWarning[];
  /** 初始化错误 */
  initError?: string | null;
}

export const Notifications: React.FC<NotificationsProps> = ({
  startupWarnings = [],
  initError,
}) => {
  const { updateInfo } = useUIState();
  const { streamingState } = useStreamingState();
  const [dismissed, setDismissed] = useState(false);

  // 流式响应时隐藏初始化错误
  const showInitError = initError && streamingState !== StreamingState.Responding;

  // 过滤可见警告
  const visibleWarnings = useMemo(() => {
    if (dismissed) return [];
    return startupWarnings;
  }, [startupWarnings, dismissed]);

  const showStartupWarnings = visibleWarnings.length > 0;

  // 按任意键关闭启动警告
  useKeypress(KeypressPriority.Critical, useCallback(() => {
    if (showStartupWarnings) {
      setDismissed(true);
      return true;
    }
    return false;
  }, [showStartupWarnings]));

  if (!showStartupWarnings && !showInitError && !updateInfo) {
    return null;
  }

  return (
    <>
      {updateInfo && <UpdateNotification message={updateInfo.message} />}
      {showStartupWarnings && (
        <Box marginY={1} flexDirection="column">
          {visibleWarnings.map((warning, index) => (
            <Box key={index} flexDirection="row">
              <Box width={3}>
                <Text color={theme.status.warning}>⚠ </Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={theme.status.warning}>{warning.message}</Text>
              </Box>
            </Box>
          ))}
          <Text dimColor>按任意键关闭</Text>
        </Box>
      )}
      {showInitError && (
        <Box
          borderStyle="round"
          borderColor={theme.status.error}
          paddingX={1}
          marginBottom={1}
        >
          <Text color={theme.status.error}>
            初始化错误: {initError}
          </Text>
        </Box>
      )}
    </>
  );
};
