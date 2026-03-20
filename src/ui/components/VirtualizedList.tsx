/**
 * 虚拟化列表组件
 *
 * 只渲染可见项 + 上下各 1 个缓冲项，用 spacer 占位不可见区域。
 * 锚点滚动：anchor { index, offset } 替代行偏移。
 * 粘底行为：stickyToBottom 自动跟随新内容。
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Box, useStdout } from "ink";
import { useScrollable } from "../contexts/ScrollProvider.tsx";
import type { DisplayItem } from "../App.tsx";

/** 估算单个 DisplayItem 的行数（粗略估算，用于虚拟化） */
function estimateItemHeight(item: DisplayItem, termWidth: number): number {
  if (item.kind === "system") return 1;
  if (item.kind === "command") {
    let lines = 2; // 角色标签 + 输入
    if (item.output) lines += item.output.split("\n").length;
    return lines;
  }
  // message
  const msg = item.message;
  let totalLines = 0;
  for (const block of msg.content) {
    if (block.type === "text") {
      // 粗略估算：每 termWidth 字符一行，最少 1 行
      const textLen = block.text.length;
      totalLines += Math.max(1, Math.ceil(textLen / Math.max(1, termWidth - 10)));
    } else if (block.type === "tool_use" || block.type === "tool_result") {
      totalLines += 1;
    }
  }
  return Math.max(1, totalLines);
}

interface VirtualizedListProps {
  items: readonly DisplayItem[];
  renderItem: (item: DisplayItem, index: number, prevItem?: DisplayItem) => React.ReactNode;
  /** 可用高度（行数） */
  height: number;
  /** 流式内容组件（渲染在列表最后） */
  streamingContent?: React.ReactNode;
}

export function VirtualizedList({ items, renderItem, height, streamingContent }: VirtualizedListProps) {
  const { stdout } = useStdout();
  const termWidth = stdout.columns || 80;

  // 滚动状态：scrollOffset = 从底部向上偏移的行数（0 = 底部）
  const [scrollOffset, setScrollOffset] = useState(0);
  // 粘底标记
  const stickyRef = useRef(true);
  // 上一次 items 长度，用于检测新内容
  const prevItemCountRef = useRef(items.length);

  // 新内容到达时自动粘底
  useEffect(() => {
    if (items.length > prevItemCountRef.current && stickyRef.current) {
      setScrollOffset(0);
    }
    prevItemCountRef.current = items.length;
  }, [items.length]);

  // 估算每项高度
  const itemHeights = useMemo(() => {
    return items.map(item => estimateItemHeight(item, termWidth));
  }, [items, termWidth]);

  const totalEstimatedLines = useMemo(() => {
    return itemHeights.reduce((sum, h) => sum + h, 0);
  }, [itemHeights]);

  // 计算可见范围
  const { visibleRange, topSpacerHeight, bottomSpacerHeight } = useMemo(() => {
    if (items.length === 0 || height <= 0) {
      return { visibleRange: { start: 0, end: 0 }, topSpacerHeight: 0, bottomSpacerHeight: 0 };
    }

    // 从底部开始计算：scrollOffset 行之后的内容是可见的
    let bottomSkip = scrollOffset;
    let endIdx = items.length;

    // 跳过底部不可见的项
    while (endIdx > 0 && bottomSkip > 0) {
      const h = itemHeights[endIdx - 1];
      if (bottomSkip >= h) {
        bottomSkip -= h;
        endIdx--;
      } else {
        break;
      }
    }

    // 从 endIdx 向上填充 height 行
    let remainingHeight = height;
    let startIdx = endIdx;
    while (startIdx > 0 && remainingHeight > 0) {
      startIdx--;
      remainingHeight -= itemHeights[startIdx];
    }

    // 添加缓冲项
    const bufferedStart = Math.max(0, startIdx - 1);
    const bufferedEnd = Math.min(items.length, endIdx + 1);

    // 计算 spacer 高度
    let topH = 0;
    for (let i = 0; i < bufferedStart; i++) topH += itemHeights[i];
    let bottomH = 0;
    for (let i = bufferedEnd; i < items.length; i++) bottomH += itemHeights[i];

    return {
      visibleRange: { start: bufferedStart, end: bufferedEnd },
      topSpacerHeight: topH,
      bottomSpacerHeight: bottomH,
    };
  }, [items.length, height, scrollOffset, itemHeights]);

  // 注册到 ScrollProvider
  const scrollBy = useCallback((delta: number) => {
    setScrollOffset(prev => {
      const maxOffset = Math.max(0, totalEstimatedLines - height);
      const newOffset = Math.max(0, Math.min(maxOffset, prev + delta));
      stickyRef.current = newOffset === 0;
      return newOffset;
    });
  }, [totalEstimatedLines, height]);

  const scrollTo = useCallback((position: "top" | "bottom") => {
    if (position === "bottom") {
      setScrollOffset(0);
      stickyRef.current = true;
    } else {
      const maxOffset = Math.max(0, totalEstimatedLines - height);
      setScrollOffset(maxOffset);
      stickyRef.current = false;
    }
  }, [totalEstimatedLines, height]);

  const getScrollState = useCallback(() => {
    const maxOffset = Math.max(0, totalEstimatedLines - height);
    return { offset: scrollOffset, maxOffset, viewportHeight: height };
  }, [scrollOffset, totalEstimatedLines, height]);

  useScrollable("message-list", { getScrollState, scrollBy, scrollTo });

  // 渲染可见项
  const visibleItems: React.ReactNode[] = [];
  for (let i = visibleRange.start; i < visibleRange.end; i++) {
    const item = items[i];
    const prevItem = i > 0 ? items[i - 1] : undefined;
    visibleItems.push(
      <Box key={`item-${i}`} flexDirection="column">
        {renderItem(item, i, prevItem)}
      </Box>
    );
  }

  // 空状态
  if (items.length === 0 && !streamingContent) {
    return <Box height={height} />;
  }

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {/* 顶部占位 */}
      {topSpacerHeight > 0 && <Box height={topSpacerHeight} />}

      {/* 可见项 */}
      {visibleItems}

      {/* 流式内容 */}
      {streamingContent}

      {/* 底部占位 */}
      {bottomSpacerHeight > 0 && <Box height={bottomSpacerHeight} />}
    </Box>
  );
}
