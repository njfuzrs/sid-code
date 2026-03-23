/**
 * 通知组件
 * 显示更新通知、初始化错误等持久性通知
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.ts';
import { useUIState } from '../contexts/UIStateContext.tsx';

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

export const Notifications: React.FC = () => {
  const { updateInfo } = useUIState();

  if (!updateInfo) {
    return null;
  }

  return (
    <>
      {updateInfo && <UpdateNotification message={updateInfo.message} />}
    </>
  );
};
