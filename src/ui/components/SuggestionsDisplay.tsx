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
import { stringWidth } from "../../ink/stringWidth.js";

/** 按显示宽度截断（CJK 安全），超出预留 1 列给省略号 */
function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  const budget = Math.max(1, maxWidth - 1);
  let width = 0;
  let result = "";
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (width + cw > budget) break;
    width += cw;
    result += ch;
  }
  return result + "…";
}

export interface Suggestion {
  /** 显示文本 */
  label: string;
  /** 插入值 */
  value: string;
  /** 描述（命令补全用） */
  description?: string;
  /** 分类图标（单字符，如 ›），显示在 label 前 */
  icon?: string;
  /** 分类标签（如「命令」「文件」「目录」），显示在行尾 dim 色 */
  tag?: string;
  /** 斜杠命令专用：该命令无参数就无法工作，补全列表回车仅回填等待输入而非直接执行 */
  requiresArgs?: boolean;
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
        // 图标前缀（如有），label 前显示
        const iconPrefix = item.icon ? `${item.icon} ` : "";
        // 行尾标签（如有），dim 色
        const tagSuffix = item.tag ? `  [${item.tag}]` : "";
        // 截断标签和描述以适应宽度（按显示列宽，CJK 安全）
        const desc = item.description ? `  ${item.description}` : "";
        const reserved = (desc ? Math.min(stringWidth(desc), 30) : 0) + stringWidth(tagSuffix) + stringWidth(iconPrefix);
        const maxLabelWidth = Math.max(4, innerWidth - reserved);
        const label = truncateToWidth(item.label, maxLabelWidth);
        const descTruncated = truncateToWidth(desc, 30);
        const labelWithIcon = `${iconPrefix}${label}`;
        const padCount = Math.max(
          0,
          innerWidth - stringWidth(labelWithIcon) - stringWidth(descTruncated) - stringWidth(tagSuffix),
        );

        return (
          <Box key={`suggestion-${realIndex}`}>
            {isActive ? (
              <Text inverse color={theme.ui.active}>
                {" "}{labelWithIcon}{descTruncated}{tagSuffix}{" ".repeat(padCount)}
              </Text>
            ) : (
              <Text>
                <Text> </Text>
                {iconPrefix ? <Text color={theme.ui.active}>{iconPrefix}</Text> : null}
                <Text>{label}</Text>
                <Text dimColor>{descTruncated}</Text>
                <Text dimColor>{tagSuffix}</Text>
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
