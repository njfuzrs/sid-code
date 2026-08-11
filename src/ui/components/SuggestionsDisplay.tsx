/**
 * 补全建议列表 UI 组件
 *
 * 在 InputArea 上方渲染补全列表，支持：
 * - ↑↓ 选择高亮
 * - 最多显示 8 条
 * - 品牌蓝 + bold 双通道高亮选中项（不靠 inverse 铺背景，兼容多行换行）
 * - 描述完整展示，过长自动换行（不截断），第二行悬挂对齐到描述起点
 */

import React from "react";
import Box from "../../ink/components/Box.tsx";
import Text from "../../ink/components/Text.tsx";
import { theme } from "../semantic-colors.ts";

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

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {visible.map((item, i) => {
        const realIndex = startIdx + i;
        const isActive = realIndex === activeIndex;
        // 图标前缀（如有），label 前显示
        const iconPrefix = item.icon ? `${item.icon} ` : "";
        // 行尾标签（如有），dim 色
        const tagText = item.tag ? `[${item.tag}]` : "";

        // 选中态：品牌蓝 + bold；非选中：正文色，描述与标签 dim
        const labelColor = isActive ? theme.ui.active : undefined;
        return (
          <Box key={`suggestion-${realIndex}`} flexDirection="row">
            {/* 行首空格 1 列，保持与其它消息缩进对齐 */}
            <Text> </Text>
            {/* label 列：不换行、不收缩，保证命令名完整 */}
            <Box flexShrink={0}>
              {iconPrefix ? (
                <Text color={theme.ui.active} bold={isActive}>
                  {iconPrefix}
                </Text>
              ) : null}
              <Text color={labelColor} bold={isActive}>
                {item.label}
              </Text>
            </Box>
            {/* 描述列：flexGrow 吃满剩余宽度，wrap 换行完整展示，不截断 */}
            {item.description ? (
              <Box flexGrow={1} paddingLeft={2}>
                <Text color={isActive ? theme.ui.active : theme.text.secondary} wrap="wrap">
                  {item.description}
                </Text>
              </Box>
            ) : (
              <Box flexGrow={1} />
            )}
            {/* 行尾标签列：不收缩，始终可见 */}
            {tagText ? (
              <Box flexShrink={0} paddingLeft={2}>
                <Text>{tagText}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {total > MAX_VISIBLE && (
        <Box>
          <Text> ({total} 条结果，显示 {startIdx + 1}-{endIdx})</Text>
        </Box>
      )}
    </Box>
  );
}
