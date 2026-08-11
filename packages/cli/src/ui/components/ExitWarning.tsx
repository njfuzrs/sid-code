/**
 * 退出警告组件
 *
 * Ctrl+C/D 二次确认提示，独立于 ToastDisplay。
 * 参考 gemini-cli ExitWarning.tsx
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";

export const ExitWarning: React.FC = () => {
  const { dialogsVisible, ctrlCPressedOnce, ctrlDPressedOnce } = useUIState();

  // 仅在 Composer 可见时（非对话框模式）显示退出警告。
  // dialogsVisible=true 表示对话框占据输入区，此时不显示 Ctrl+C/D 提示。
  if (dialogsVisible) return null;

  return (
    <>
      {ctrlCPressedOnce && (
        <Box marginTop={0}>
          <Text color={theme.status.warning}>{`${ARROW_PROMPT} 再按一次 Ctrl+C 退出，或继续输入以取消`}</Text>
        </Box>
      )}
      {ctrlDPressedOnce && (
        <Box marginTop={0}>
          <Text color={theme.status.warning}>{`${ARROW_PROMPT} 再按一次 Ctrl+D 退出，或继续输入以取消`}</Text>
        </Box>
      )}
    </>
  );
};
