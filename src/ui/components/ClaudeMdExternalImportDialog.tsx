/**
 * M4：CLAUDE.md 外部导入审批对话框
 *
 * 当 CLAUDE.md 通过 @import 引用了项目根之外的文件（含 ~/ 家目录）时，
 * 首次遇到弹出本对话框征询用户批准。这是一道安全闸门——防止 poisoned CLAUDE.md
 * 通过 @import 静默拉入项目外的恶意指令（对齐 CC ClaudeMdExternalIncludesDialog）。
 *
 * 批准/拒绝结果持久化到 project 级 config（claudeMdExternalImportsApproved），
 * 后续启动静默沿用。用户可通过 /config 或重新触发调整。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";

interface ChoiceItem extends SelectionListItem<boolean> {
  label: string;
  desc: string;
}

const OPTIONS: ChoiceItem[] = [
  { value: true, key: "yes", label: "允许外部导入", desc: "信任并展开项目外的 @import（记住选择）" },
  { value: false, key: "no", label: "禁用外部导入", desc: "跳过所有项目外的 @import（记住选择）" },
];

interface Props {
  /** 被跳过的外部导入路径列表（展示给用户过目）。 */
  paths: string[];
  /** 用户选择回调：approved=true 允许，false 拒绝。 */
  onDecision: (approved: boolean) => void;
  /** Esc 关闭（视作暂不决定，本会话保持跳过）。 */
  onClose: () => void;
}

/** 展示上限，避免过长路径列表撑爆对话框。 */
const MAX_PATHS_SHOWN = 5;

export const ClaudeMdExternalImportDialog: React.FC<Props> = ({ paths, onDecision, onClose }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const shown = paths.slice(0, MAX_PATHS_SHOWN);
  const extra = paths.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>允许加载项目外的 CLAUDE.md 导入？</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          你的 CLAUDE.md 通过 @import 引用了项目根之外的文件。为防止外部文件注入未经审阅的指令，
          这些导入默认被跳过。是否允许加载？
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {shown.map((p) => (
          <Text key={p} color={theme.text.secondary}>  · {p}</Text>
        ))}
        {extra > 0 && <Text dimColor>  …等共 {paths.length} 个</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<boolean, ChoiceItem>
          items={OPTIONS}
          initialIndex={1}
          onSelect={(v) => onDecision(v)}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={2}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => (
            <Box>
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
              <Text color={theme.text.secondary}>  {item.desc}</Text>
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor italic>Esc 暂不决定（本会话保持跳过）</Text>
      </Box>
    </Box>
  );
};
