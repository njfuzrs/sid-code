/**
 * 项目级扩展信任对话框（B20 / D63 闭环的 TUI 前端）
 *
 * 项目 `.sid-code/` / `.claude/` 下的 skill / 命令 / agent 跟仓库走，等于别人写的提示词，
 * 首次加载前必须由用户确认。此前这一步在 TUI 起来之前用 readline 问 `继续吗？[y/N]`：
 * 与 TUI 里的 MCP 审批框、工作区信任框是两套样式，而且 TUI 一接管 stdin 就再也问不了——
 * 会话中途热重载 / 动态发现到的新扩展只能静默不加载。现在统一走这个对话框。
 *
 * 安全默认（src/ui/CLAUDE.md L4-E）：初始聚焦「不信任」，手滑回车不授予信任。
 * Esc 视作本次不信任：不加载、不落盘，下次启动仍会询问。
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";

/** 对话框只需要展示字段，不依赖 core 的 ParsedExtensionFile */
export interface ExtensionTrustItem {
  kind: string;
  displayPath: string;
}

interface ChoiceItem extends SelectionListItem<boolean> {
  label: string;
  desc: string;
}

const OPTIONS: ChoiceItem[] = [
  {
    value: true,
    key: "yes",
    label: "是，信任并加载",
    desc: "记住选择（内容变化后会再次询问）",
  },
  { value: false, key: "no", label: "不信任", desc: "本次不加载（下次启动仍会询问）" },
];

/** 展示上限，避免过长清单撑爆对话框 */
const MAX_ITEMS_SHOWN = 8;

interface Props {
  items: ExtensionTrustItem[];
  workspacePath: string;
  onDecision: (trusted: boolean) => void;
  /** Esc：视作本次不信任 */
  onClose: () => void;
}

export const ExtensionTrustDialog: React.FC<Props> = ({
  items,
  workspacePath,
  onDecision,
  onClose,
}) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const shown = items.slice(0, MAX_ITEMS_SHOWN);
  const extra = items.length - shown.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.status.warning}>
        发现 {items.length} 个未信任的项目级扩展
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          这些 skill / 命令 / agent 来自仓库，等于别人写的提示词。请确认来源可信再加载。
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>目录: </Text>
        <Text color={theme.ui.active}>{workspacePath}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {shown.map((item) => (
          <Box key={item.displayPath}>
            <Text color={theme.status.warning}>{ARROW_PROMPT} </Text>
            <Text color={theme.text.primary}>[{item.kind}] </Text>
            <Text color={theme.text.secondary}>{item.displayPath}</Text>
          </Box>
        ))}
        {extra > 0 && <Text> …等共 {items.length} 项</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<boolean, ChoiceItem>
          items={OPTIONS}
          // 安全默认（L4-E）：初始聚焦「不信任」
          initialIndex={1}
          onSelect={(v) => onDecision(v)}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={2}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => (
            <Box>
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
              <Text color={theme.text.secondary}> {item.desc}</Text>
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>Esc 视作不信任</Text>
      </Box>
    </Box>
  );
};
