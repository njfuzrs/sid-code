/**
 * Copy Mode 警告组件
 *
 * 在 Copy Mode 下显示提示信息，告知用户如何滚动和退出。
 * Copy Mode 禁用鼠标事件，允许终端原生文本选择。
 *
 * 参考 gemini-cli/packages/cli/src/ui/components/CopyModeWarning.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../semantic-colors.ts";

interface CopyModeWarningProps {
  enabled: boolean;
}

export const CopyModeWarning: React.FC<CopyModeWarningProps> = ({ enabled }) => {
  if (!enabled) return null;

  return (
    <Box>
      <Text color={theme.status.warning}>
        Copy Mode 已启用。使用 PageUp/PageDown 滚动，按 Ctrl+S 或其他键退出。
      </Text>
    </Box>
  );
};
