/**
 * 退出警告组件
 *
 * Ctrl+C/D 二次确认提示，独立于 ToastDisplay。
 * 参考 gemini-cli ExitWarning.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../semantic-colors.ts";
import { useUIState } from "../contexts/UIStateContext.tsx";

export const ExitWarning: React.FC = () => {
  const { dialogsVisible, ctrlCPressedOnce, ctrlDPressedOnce } = useUIState();

  // 仅在 Composer 可见时（非对话框模式）显示退出警告
  if (!dialogsVisible) return null;

  return (
    <>
      {ctrlCPressedOnce && (
        <Box marginTop={0}>
          <Text color={theme.status.warning}>再次按 Ctrl+C 退出</Text>
        </Box>
      )}
      {ctrlDPressedOnce && (
        <Box marginTop={0}>
          <Text color={theme.status.warning}>再次按 Ctrl+D 退出</Text>
        </Box>
      )}
    </>
  );
};
