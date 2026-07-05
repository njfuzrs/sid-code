/**
 * Memory 管理面板（/memory 无参时打开）
 *
 * 状态机：
 *   list    → 记忆文件列表（项目级/用户级 CLAUDE.md）
 *   preview → 选中文件的只读内容预览（Esc 返回 list）
 *
 * 只做展示与浏览，不涉及编辑/删除（编辑请用编辑器打开对应路径）。
 */

import React, { useState, useMemo } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import stringWidth from "string-width";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import {
  discoverMemoryFiles,
  readMemoryContent,
  formatFileSize,
  formatMtime,
  type MemoryFileInfo,
} from "../utils/memory-files.ts";

interface MemoryDialogProps {
  onClose: () => void;
  cwd: string;
}

type ViewState = { type: "list" } | { type: "preview"; file: MemoryFileInfo };

interface MemoryItem extends SelectionListItem<string> {
  info: MemoryFileInfo;
}

const SCOPE_LABEL: Record<MemoryFileInfo["scope"], string> = {
  project: "项目级",
  user: "用户级",
};

/** 预览最多渲染的行数（避免超大文件撑爆动态区）。 */
const MAX_PREVIEW_LINES = 30;

export const MemoryDialog: React.FC<MemoryDialogProps> = ({ onClose, cwd }) => {
  const [view, setView] = useState<ViewState>({ type: "list" });

  const files = useMemo(() => discoverMemoryFiles(cwd), [cwd]);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      // preview → 返回 list；list → 关闭面板
      if (view.type === "preview") {
        setView({ type: "list" });
      } else {
        onClose();
      }
      return true;
    }
    return false;
  });

  // ── 预览视图 ──
  if (view.type === "preview") {
    const { file } = view;
    const content = readMemoryContent(file.path);
    const allLines = content.split("\n");
    const lines = allLines.slice(0, MAX_PREVIEW_LINES);
    const truncated = allLines.length > MAX_PREVIEW_LINES;

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Box>
          <Text bold color={theme.ui.active}>{file.displayPath}</Text>
          <Text color={theme.text.secondary}> ({SCOPE_LABEL[file.scope]})</Text>
        </Box>
        <Text color={theme.text.secondary}>
          {formatFileSize(file.size)} · {formatMtime(file.mtimeMs)} 修改
        </Text>
        <Box marginTop={1} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.text.primary} wrap="truncate-end">
              {line || " "}
            </Text>
          ))}
          {truncated && (
            <Text dimColor italic>
              … 还有 {allLines.length - MAX_PREVIEW_LINES} 行（完整内容请用编辑器打开）
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor italic>Esc 返回列表</Text>
        </Box>
      </Box>
    );
  }

  // ── 列表视图 ──
  if (files.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>Memory 管理</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>未发现任何 CLAUDE.md 记忆文件</Text>
        </Box>
        <Text dimColor>可在项目根目录创建 CLAUDE.md，或 ~/.claude/CLAUDE.md（用户级）</Text>
        <Box marginTop={1}>
          <Text dimColor italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  const items: MemoryItem[] = files.map((info, i) => ({
    value: info.path,
    key: `mem-${i}`,
    info,
  }));

  // 路径列宽对齐
  const pathColWidth = Math.max(...files.map((f) => stringWidth(f.displayPath)), 0);

  const handleSelect = (path: string) => {
    const file = files.find((f) => f.path === path);
    if (file) setView({ type: "preview", file });
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Box>
        <Text bold color={theme.ui.active}>Memory 管理</Text>
        <Text color={theme.text.secondary}> · {files.length} 个文件</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<string, MemoryItem>
          items={items}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={12}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const { info } = item;
            const pad = " ".repeat(Math.max(2, pathColWidth - stringWidth(info.displayPath) + 2));
            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{info.displayPath}</Text>
                <Text color={theme.text.secondary}>
                  {pad}
                  {SCOPE_LABEL[info.scope]} · {formatFileSize(info.size)} · {formatMtime(info.mtimeMs)}
                </Text>
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor italic>↑↓ 导航 · Enter 查看 · Esc 关闭</Text>
      </Box>
    </Box>
  );
};
