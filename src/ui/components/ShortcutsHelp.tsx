/**
 * 快捷键帮助组件
 *
 * ShortcutsHint：底部简要提示（一行）
 * ShortcutsHelp：完整快捷键列表（? 键展开）
 *
 * 参考 gemini-cli ShortcutsHint.tsx / ShortcutsHelp.tsx
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import { theme } from "../semantic-colors.ts";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";

// ── 快捷键数据 ──

interface ShortcutItem {
  key: string;
  description: string;
}

const SHORTCUTS: ShortcutItem[] = [
  { key: "!", description: "shell 模式" },
  { key: "@", description: "选择文件/目录" },
  { key: "Shift+Enter", description: "多行输入" },
  { key: "Ctrl+S", description: "Copy Mode" },
  { key: "Alt+M", description: "切换 Markdown 渲染" },
  { key: "Ctrl+O", description: "切换高度限制" },
  { key: "↑/↓", description: "输入历史" },
  { key: "Ctrl+R", description: "反向搜索历史" },
  { key: "Ctrl+C", description: "退出" },
  { key: "Esc", description: "取消当前操作" },
  { key: "Shift+Tab", description: "切换权限模式" },
];

// ── ShortcutsHint（简要提示） ──

export const ShortcutsHint: React.FC = () => (
  <Text color={theme.text.secondary}> ? 查看快捷键 </Text>
);

// ── ShortcutsHelp（完整列表） ──

const NARROW_WIDTH_THRESHOLD = 60;

const Shortcut: React.FC<{ item: ShortcutItem }> = ({ item }) => (
  <Box flexDirection="row">
    <Box flexShrink={0} marginRight={1}>
      <Text color={theme.text.accent}>{item.key}</Text>
    </Box>
    <Box flexGrow={1}>
      <Text color={theme.text.primary}>{item.description}</Text>
    </Box>
  </Box>
);

export const ShortcutsHelp: React.FC = () => {
  const { stdout } = useStdout();
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;
  const isNarrow = termWidth < NARROW_WIDTH_THRESHOLD;

  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1}>
        <Text color={theme.text.accent} bold>快捷键</Text>
        <Text color={theme.text.secondary}> — 输入 /help 查看更多</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" paddingLeft={1} paddingRight={2}>
        {SHORTCUTS.map((item, index) => (
          <Box
            key={`${item.key}-${index}`}
            width={isNarrow ? "100%" : "33%"}
            paddingRight={isNarrow ? 0 : 2}
          >
            <Shortcut item={item} />
          </Box>
        ))}
      </Box>
    </Box>
  );
};
