/**
 * 退出警告组件
 *
 * Ctrl+C/D 二次确认提示，独立于 ToastDisplay。
 * 参考 gemini-cli ExitWarning.tsx
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useHeldRows } from "../hooks/useHeldRows.ts";

export const ExitWarning: React.FC<{ busy?: boolean }> = ({ busy = false }) => {
  const { dialogsVisible, ctrlCPressedOnce, ctrlDPressedOnce } = useUIState();

  // 仅在 Composer 可见时（非对话框模式）显示退出警告。
  // dialogsVisible=true 表示对话框占据输入区，此时不显示 Ctrl+C/D 提示。
  const visible = !dialogsVisible;
  const rows = visible ? Number(ctrlCPressedOnce) + Number(ctrlDPressedOnce) : 0;
  // 提示出现过就占住到下一轮开始（useHeldRows）：取消退出意图时提示行消失，不让主屏帧变矮。
  // 对话框打开时整块让位给对话框，水位照算——关对话框后不会先缩一下再撑回。
  const held = useHeldRows(rows, busy);
  if (!visible || held === 0) return null;

  return (
    <Box flexDirection="column" minHeight={held}>
      {ctrlCPressedOnce && (
        <Box marginTop={0}>
          <Text
            color={theme.status.warning}
          >{`${ARROW_PROMPT} 再按一次 Ctrl+C 退出，或继续输入以取消`}</Text>
        </Box>
      )}
      {ctrlDPressedOnce && (
        <Box marginTop={0}>
          <Text
            color={theme.status.warning}
          >{`${ARROW_PROMPT} 再按一次 Ctrl+D 退出，或继续输入以取消`}</Text>
        </Box>
      )}
    </Box>
  );
};
