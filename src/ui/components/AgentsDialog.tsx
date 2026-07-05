import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";

interface AgentsDialogProps {
  onClose: () => void;
}

export const AgentsDialog: React.FC<AgentsDialogProps> = ({ onClose }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>{ARROW_PROMPT} Agents</Text>
      <Box marginTop={1} flexDirection="column" gap={0}>
        <Text>Agent 类型在 <Text color={theme.ui.active}>.sid-code/agents/</Text> 或 <Text color={theme.ui.active}>~/.sid-code/agents/</Text> 目录下以 .md 文件定义</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>每个 .md 文件对应一个 Agent 类型，文件内容即该 Agent 的系统提示词与配置。</Text>
        </Box>
      </Box>
      <Box marginTop={1}><Text dimColor italic>Esc 关闭</Text></Box>
    </Box>
  );
};
