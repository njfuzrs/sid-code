/**
 * 补全建议列表 UI 组件
 *
 * 在 InputArea 上方渲染补全列表，支持：
 * - ↑↓ 选择高亮
 * - 最多显示 8 条
 * - 使用 inverse 样式高亮选中项
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";

export interface Suggestion {
  /** 显示文本 */
  label: string;
  /** 插入值 */
  value: string;
  /** 描述（命令补全用） */
  description?: string;
}

interface SuggestionsDisplayProps {
  suggestions: Suggestion[];
  activeIndex: number;
  width: number;
}

const MAX_VISIBLE = 8;

export function SuggestionsDisplay({ suggestions, activeIndex, width }: SuggestionsDisplayProps) {
  if (suggestions.length === 0) return null;

  // 计算可见窗口（当建议超过 MAX_VISIBLE 时滚动）
  const total = suggestions.length;
  let startIdx = 0;
  if (total > MAX_VISIBLE) {
    // 让选中项尽量在中间
    startIdx = Math.max(0, Math.min(activeIndex - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
  }
  const endIdx = Math.min(startIdx + MAX_VISIBLE, total);
  const visible = suggestions.slice(startIdx, endIdx);

  const innerWidth = Math.max(20, width - 4); // paddingX=2 左右各 1

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((item, i) => {
        const realIndex = startIdx + i;
        const isActive = realIndex === activeIndex;
        // 截断标签和描述以适应宽度
        const desc = item.description ? `  ${item.description}` : "";
        const maxLabelWidth = innerWidth - (desc ? Math.min(desc.length, 30) : 0);
        const label = item.label.length > maxLabelWidth
          ? item.label.slice(0, maxLabelWidth - 1) + "…"
          : item.label;
        const descTruncated = desc.length > 30 ? desc.slice(0, 29) + "…" : desc;

        return (
          <Box key={`suggestion-${realIndex}`}>
            {isActive ? (
              <Text inverse color={theme.ui.active}>
                {" "}{label}{descTruncated}{" ".repeat(Math.max(0, innerWidth - label.length - descTruncated.length))}
              </Text>
            ) : (
              <Text>
                <Text> {label}</Text>
                <Text dimColor>{descTruncated}</Text>
              </Text>
            )}
          </Box>
        );
      })}
      {total > MAX_VISIBLE && (
        <Box>
          <Text dimColor> ({total} 条结果，显示 {startIdx + 1}-{endIdx})</Text>
        </Box>
      )}
    </Box>
  );
}
