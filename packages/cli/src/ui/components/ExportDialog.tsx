/**
 * 导出对话选择面板（/export 无参时打开）
 *
 * 4 个选项：剪贴板(文本/JSON) + 文件(文本/JSON)。
 * 选中后直接执行导出，在面板内完成全流程。
 */

import React, { useState } from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";

export type ExportTarget = "clipboard" | "file";
export type ExportFormat = "md" | "json" | "both";

interface ExportOption extends SelectionListItem<string> {
  target: ExportTarget;
  format: ExportFormat;
  label: string;
  desc: string;
}

const OPTIONS: ExportOption[] = [
  {
    value: "clip-md",
    key: "clip-md",
    target: "clipboard",
    format: "md",
    label: "复制到剪贴板（文本）",
    desc: "人类可读 Markdown 格式",
  },
  {
    value: "clip-json",
    key: "clip-json",
    target: "clipboard",
    format: "json",
    label: "复制到剪贴板（JSON）",
    desc: "完整结构化数据，可恢复上下文",
  },
  {
    value: "file-md",
    key: "file-md",
    target: "file",
    format: "md",
    label: "保存到文件（文本）",
    desc: "Markdown 文件到当前目录",
  },
  {
    value: "file-json",
    key: "file-json",
    target: "file",
    format: "json",
    label: "保存到文件（JSON）",
    desc: "JSON 文件到当前目录",
  },
  {
    value: "file-both",
    key: "file-both",
    target: "file",
    format: "both",
    label: "保存到文件（文本 + JSON）",
    desc: "同时生成两个文件，各取所需",
  },
];

interface ExportDialogProps {
  onClose: () => void;
  onExport: (target: ExportTarget, format: ExportFormat) => void;
}

export const ExportDialog: React.FC<ExportDialogProps> = ({ onClose, onExport }) => {
  const [status, setStatus] = useState<string | null>(null);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const handleSelect = (value: string) => {
    const option = OPTIONS.find((o) => o.value === value);
    if (!option) return;
    setStatus("正在导出…");
    // 异步执行导出，回调由上层传入
    onExport(option.target, option.format);
    onClose();
  };

  if (status) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text color={theme.ui.active}>{status}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.ui.active}>
        导出对话
      </Text>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<string, ExportOption>
          items={OPTIONS}
          initialIndex={0}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={true}
          maxItemsToShow={6}
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
        <Text italic>↑↓ 导航 · Enter 确认 · Esc 取消</Text>
      </Box>
    </Box>
  );
};
