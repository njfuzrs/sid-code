/**
 * 并发冲突选择框（Phase 2.1）
 *
 * 当检测到并发冲突时，弹出选择框让用户决定：
 * - 停下来（去关闭其他会话）
 * - 跳过冲突文件
 * - 继续照常做（接受覆盖风险）
 *
 * 视觉规范：
 * - 使用 warning 状态色（黄色）而非 error（红色），因为冲突不是错误，是警告
 * - 遵循 L4-E 危险操作规范：默认聚焦"最安全"选项（停下来）
 * - 遵循 L2.2 单容器规范：单个 round 边框
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import type { ConflictReport } from "@sid-code/core/session/conflict-detector.ts";

export type ConflictAction = "stop" | "skip" | "continue";

interface ConflictDialogProps {
  report: ConflictReport;
  onSelect: (action: ConflictAction) => void;
  onClose: () => void;
}

interface ConflictOption extends SelectionListItem<ConflictAction> {
  label: string;
  desc: string;
}

const OPTIONS: ConflictOption[] = [
  {
    value: "stop",
    key: "stop",
    label: "先停下，我去关掉其它会话",
    desc: "最安全，不会产生交叉覆盖",
  },
  {
    value: "skip",
    key: "skip",
    label: "跳过冲突文件",
    desc: "只做无重叠的部分",
  },
  {
    value: "continue",
    key: "continue",
    label: "继续照常做",
    desc: "接受覆盖风险",
  },
];

export const ConflictDialog: React.FC<ConflictDialogProps> = ({ report, onSelect, onClose }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const handleSelect = (value: ConflictAction) => {
    onSelect(value);
  };

  // 格式化冲突会话列表
  const sessionLines = report.conflictingSessions.map((s) => {
    const timeAgo =
      s.secondsAgo < 60 ? `${s.secondsAgo} 秒前` : `${Math.floor(s.secondsAgo / 60)} 分钟前`;
    return `  · 会话 ${s.sessionId.slice(-8)} (PID ${s.pid}) — ${s.lastOperation} (${timeAgo})`;
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text bold color={theme.status.warning}>
          ⚠ 并发冲突
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>
          文件 <Text bold>{report.filePath}</Text> {report.summary}
        </Text>
      </Box>

      {sessionLines.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {sessionLines.map((line, i) => (
            <Text key={i} color={theme.text.secondary}>
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>继续编辑可能导致互相覆盖。怎么处理？</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<ConflictAction, ConflictOption>
          items={OPTIONS}
          initialIndex={0}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={true}
          maxItemsToShow={4}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => (
            <Box>
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
              <Text color={theme.text.secondary}> — {item.desc}</Text>
            </Box>
          )}
        />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary} italic>
          ↑↓ 导航 · Enter 选择 · Esc 取消
        </Text>
      </Box>
    </Box>
  );
};
