/**
 * 统一错误面板组件
 *
 * 底部常驻区域，显示所有运行时错误的原因 + 建议方案。
 * 只手动关闭（Ctrl+E），不自动消失。
 *
 * 视觉语言（遵循 src/ui/CLAUDE.md）：
 * - 红色 borderLeft 竖线（不用 round 边框盒子）
 * - 标题：ERROR_MARK + theme.status.error 颜色
 * - 正文/建议：theme.text.primary（柔和，不全红）
 * - 关闭提示渐进衰减（显示 3 次后不再提示）
 */

import React, { useCallback } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { ERROR_MARK } from "../constants/figures.ts";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { ErrorPanelItem } from "../App.tsx";

interface ErrorPanelProps {
  items: ErrorPanelItem[];
  onDismiss: () => void;
  width: number;
  /** 面板被展示的累计次数（驱动关闭提示渐进衰减） */
  showCount?: number;
}

/** 关闭提示显示上限（超过后不再提示，避免唠叨——L4.C 渐进衰减） */
const DISMISS_HINT_MAX_SHOWS = 3;

export const ErrorPanel: React.FC<ErrorPanelProps> = ({
  items,
  onDismiss,
  width,
  showCount = 0,
}) => {
  // Ctrl+E 关闭错误面板（范式参照 Notifications.tsx:73）
  useKeypress(KeypressPriority.High, useCallback((key: { ctrl?: boolean; name?: string }) => {
    if (key.ctrl && key.name === "e" && items.length > 0) {
      onDismiss();
      return true; // 消费按键，阻止冒泡
    }
    return false;
  }, [items.length, onDismiss]));

  if (items.length === 0) {
    return null;
  }

  const bodyWidth = Math.max(1, width - 2);
  const showDismissHint = showCount < DISMISS_HINT_MAX_SHOWS;

  return (
    <Box
      marginLeft={1}
      paddingLeft={1}
      borderStyle="single"
      borderLeft={true}
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={theme.status.error}
      flexDirection="column"
      width={bodyWidth}
      marginTop={1}
    >
      {items.map((item, index) => (
        <Box key={item.id} flexDirection="column" marginBottom={index < items.length - 1 ? 1 : 0}>
          {/* 错误标题 */}
          <Box>
            <Text color={theme.status.error} bold>{`${ERROR_MARK} `}</Text>
            <Text color={theme.status.error} bold>{item.title}</Text>
          </Box>
          {/* 详细信息（如有） */}
          {item.detail && (
            <Box marginLeft={2}>
              <Text color={theme.text.secondary} wrap="truncate-end">{item.detail}</Text>
            </Box>
          )}
          {/* 建议方案 */}
          <Box marginLeft={2}>
            <Text color={theme.text.primary}>{`→ ${item.suggestion}`}</Text>
          </Box>
        </Box>
      ))}
      {/* 关闭提示（渐进衰减） */}
      {showDismissHint && (
        <Box marginTop={1}>
          <Text dimColor>按 Ctrl+E 关闭</Text>
        </Box>
      )}
    </Box>
  );
};
