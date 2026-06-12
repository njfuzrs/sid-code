/**
 * 快捷键帮助组件
 *
 * ShortcutsHint：底部简要提示（一行）
 * ShortcutsHelp：完整快捷键列表（? 键展开）
 *
 * 参考 gemini-cli ShortcutsHint.tsx / ShortcutsHelp.tsx
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import useStdout from "../../ink/_vendor/use-stdout.js";
import { theme } from "../semantic-colors.ts";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";
import { DEFAULT_BINDINGS } from "../keybindings/defaultBindings.ts";

// ── 快捷键数据 ──

interface ShortcutItem {
  key: string;
  description: string;
}

// 从集中声明表(K1)生成,不再独立硬编码。改键位只改 defaultBindings.ts 一处。
const SHORTCUTS: ShortcutItem[] = DEFAULT_BINDINGS
  .filter((b) => b.showInHelp)
  .map((b) => ({ key: b.display, description: b.description }));

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
