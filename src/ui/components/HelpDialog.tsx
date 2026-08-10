import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import type { UnifiedCommandRegistry } from "../../command/unified-registry.ts";

interface HelpDialogProps {
  onClose: () => void;
  registry: UnifiedCommandRegistry;
}

const COMMON_COMMANDS = [
  { name: "model", desc: "切换模型（-p 持久化）" },
  { name: "effort", desc: "调整推理强度" },
  { name: "think", desc: "思考模式开关" },
  { name: "theme", desc: "切换主题（-p 持久化）" },
  { name: "language", desc: "切换输出语言（-p 持久化）" },
  { name: "config", desc: "查看/修改配置" },
  { name: "memory", desc: "管理记忆文件" },
  { name: "stats", desc: "会话统计" },
  { name: "hooks", desc: "Hook 管理" },
  { name: "permissions", desc: "权限管理" },
  { name: "mcp", desc: "MCP 服务管理" },
  { name: "help", desc: "显示帮助" },
];

const SHORTCUTS = [
  { key: "Esc", desc: "中断当前操作" },
  { key: "Ctrl+C", desc: "退出程序" },
  { key: "Ctrl+D", desc: "退出程序" },
  { key: "Tab", desc: "命令补全" },
];

export const HelpDialog: React.FC<HelpDialogProps> = ({ onClose }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>{ARROW_PROMPT} 帮助</Text>

      {/* 常用命令 */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>常用命令</Text>
        <Box marginTop={0} flexDirection="column" paddingLeft={2}>
          {COMMON_COMMANDS.map((cmd) => (
            <Box key={cmd.name} flexDirection="row" gap={1}>
              <Box width={16} flexShrink={0}>
                <Text color={theme.ui.active}>/{cmd.name}</Text>
              </Box>
              <Text color={theme.text.secondary}>{cmd.desc}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* 快捷键 */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>快捷键</Text>
        <Box marginTop={0} flexDirection="column" paddingLeft={2}>
          {SHORTCUTS.map((s) => (
            <Box key={s.key} flexDirection="row" gap={1}>
              <Box width={16} flexShrink={0}>
                <Text color={theme.ui.active}>{s.key}</Text>
              </Box>
              <Text color={theme.text.secondary}>{s.desc}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      <Box marginTop={1}><Text italic>输入 /commands 查看全部命令 · Esc 关闭</Text></Box>
    </Box>
  );
};
