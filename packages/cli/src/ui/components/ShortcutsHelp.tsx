/**
 * 快捷键帮助组件
 *
 * ShortcutsHint：底部简要提示（一行）
 * ShortcutsHelp：完整快捷键列表（? 键展开）
 *
 * 参考 gemini-cli ShortcutsHint.tsx / ShortcutsHelp.tsx
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { useStdout } from "../render-port/hooks.ts";
import { theme } from "../semantic-colors.ts";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";
import { useKeybindings } from "../contexts/KeybindingContext.tsx";
import {
  buildHelpSections,
  computeHelpLayout,
  HELP_COLUMN_GAP,
  type HelpItem,
} from "../keybindings/helpShortcuts.ts";

// ── ShortcutsHint（简要提示） ──

export const ShortcutsHint: React.FC = () => (
  <Text color={theme.text.secondary}> ? 查看快捷键 </Text>
);

// ── ShortcutsHelp（完整列表） ──

const Shortcut: React.FC<{ item: HelpItem; keyWidth: number }> = ({ item, keyWidth }) => (
  <Box flexDirection="row">
    <Box flexShrink={0} width={keyWidth} marginRight={1}>
      <Text color={theme.text.accent}>{item.key}</Text>
    </Box>
    <Box flexGrow={1} flexShrink={1}>
      <Text color={theme.text.primary}>{item.description}</Text>
    </Box>
  </Box>
);

export const ShortcutsHelp: React.FC = () => {
  const { stdout } = useStdout();
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;

  // 从合并后的运行时键位表(默认 + 用户 keybindings.json)生成,
  // 用户自定义键位会自动反映在帮助里(K2/K4 闭环)；再补上不走查表的固定键。
  const { bindings } = useKeybindings();
  const sections = buildHelpSections(bindings);
  const { columnWidth, keyWidth } = computeHelpLayout(sections, termWidth);

  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1}>
        <Text color={theme.text.accent} bold>
          快捷键
        </Text>
        <Text color={theme.text.secondary}> — 任意键关闭 · /keybindings 查看可改绑的动作</Text>
      </Box>
      {sections.map((section) => (
        <Box key={section.group} flexDirection="column" paddingLeft={1} paddingRight={2}>
          <Text color={theme.text.secondary}>{section.title}</Text>
          <Box flexDirection="row" flexWrap="wrap">
            {section.items.map((item, index) => (
              <Box
                key={`${item.key}-${index}`}
                width={columnWidth}
                flexShrink={0}
                paddingRight={HELP_COLUMN_GAP}
              >
                <Shortcut item={item} keyWidth={keyWidth} />
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
};
