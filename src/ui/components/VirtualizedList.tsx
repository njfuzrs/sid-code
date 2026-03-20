/**
 * 虚拟化列表组件
 *
 * 使用 Ink 原生 overflowY="scroll" + scrollTop 实现真正的滚动，
 * 同时保留虚拟化渲染（只渲染可见项 + 缓冲项）以保证性能。
 *
 * 参考 Gemini CLI 的 VirtualizedList 实现：
 * - 用 ResizeObserver 测量实际渲染高度
 * - anchor-based 定位 + sticky-to-bottom 粘底
 * - Ink 原生滚动条
 *
 * 坐标系：scrollTop = 从顶部向下偏移的行数（0 = 顶部）
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Box, ResizeObserver, useStdout, type DOMElement } from "ink";
import { useScrollable } from "../contexts/ScrollProvider.tsx";
import type { DisplayItem } from "../App.tsx";

const SCROLL_TO_END = Number.MAX_SAFE_INTEGER;

/** 估算单个 DisplayItem 的行数（用于未测量项的初始高度） */
function estimateItemHeight(item: DisplayItem, termWidth: number): number {
  if (item.kind === "system") return 1;
  if (item.kind === "command") {
    let lines = 2;
    if (item.output) lines += item.output.split("\n").length;
    return lines;
  }
  const msg = item.message;
  let totalLines = 0;
  const effectiveWidth = Math.max(1, termWidth - 12);
  for (const block of msg.content) {
    if (block.type === "text") {
      const textLen = block.text.length;
      totalLines += Math.max(1, Math.ceil((textLen * 1.3) / effectiveWidth));
    } else if (block.type === "tool_use" || block.type === "tool_result") {
      totalLines += 1;
    }
  }
  return Math.max(1, totalLines);
}

/** 为 DisplayItem 生成稳定 key */
function getItemKey(item: DisplayItem, index: number): string {
  if (item.kind === "system") return `sys-${index}-${item.text.slice(0, 20)}`;
  if (item.kind === "command") return `cmd-${index}-${item.input.slice(0, 20)}`;
  const msg = item.message;
  const first = msg.content[0];
  if (first?.type === "text") return `msg-${index}-${msg.role}-${first.text.slice(0, 16)}`;
  if (first?.type === "tool_use") return `msg-${index}-${msg.role}-tu-${first.id}`;
  if (first?.type === "tool_result") return `msg-${index}-${msg.role}-tr-${first.tool_use_id}`;
  return `msg-${index}-${msg.role}`;
}

interface VirtualizedListProps {
  items: readonly DisplayItem[];
  renderItem: (item: DisplayItem, index: number, prevItem?: DisplayItem) => React.ReactNode;
  /** 可用高度（行数） */
  height: number;
  /** 流式内容组件（渲染在列表最后） */
  streamingContent?: React.ReactNode;
  /** 流式文本（用于计算滚动高度） */
  streamingText?: string;
}

export function VirtualizedList({ items, renderItem, height, streamingContent, streamingText }: VirtualizedListProps) {
  const { stdout } = useStdout();
  const termWidth = stdout.columns || 80;

  // ── 实际高度测量 ──
  // key → 实际渲染高度（行数）
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const itemRefsMap = useRef<Map<string, DOMElement>>(new Map());
  const nodeToKeyRef = useRef(new WeakMap<DOMElement, string>());

  // ResizeObserver 测量每个渲染项的实际高度
  const itemsObserver = useMemo(
    () => new ResizeObserver((entries) => {
      setMeasuredHeights((prev) => {
        let next: Record<string, number> | null = null;
        for (const entry of entries) {
          const key = nodeToKeyRef.current.get(entry.target);
          if (key !== undefined) {
            const h = Math.round(entry.contentRect.height);
            if (prev[key] !== h) {
              if (!next) next = { ...prev };
              next[key] = h;
            }
          }
        }
        return next ?? prev;
      });
    }),
    [],
  );

  useEffect(() => () => { itemsObserver.disconnect(); }, [itemsObserver]);

  // ── 高度计算（估算 + 实测混合） ──
  const getItemHeight = useCallback((index: number): number => {
    const item = items[index];
    if (!item) return 1;
    const key = getItemKey(item, index);
    return measuredHeights[key] ?? estimateItemHeight(item, termWidth);
  }, [items, measuredHeights, termWidth]);

  // offsets[i] = items[0..i) 的累计高度，offsets[items.length] = totalHeight
  const { offsets, totalItemsHeight } = useMemo(() => {
    const offsets: number[] = [0];
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      total += getItemHeight(i);
      offsets.push(total);
    }
    return { offsets, totalItemsHeight: total };
  }, [items, getItemHeight]);

  // 流式内容估算高度
  const streamingHeight = useMemo(() => {
    if (!streamingText) return 0;
    const effectiveWidth = Math.max(1, termWidth - 12);
    return Math.max(1, Math.ceil(streamingText.length / effectiveWidth));
  }, [streamingText, termWidth]);

  const totalHeight = totalItemsHeight + streamingHeight;

  // ── 滚动状态 ──
  const [isStickingToBottom, setIsStickingToBottom] = useState(true);
  // scrollTop: 从顶部偏移的行数
  const [scrollTop, setScrollTop] = useState(SCROLL_TO_END);

  // 追踪上一帧状态，用于粘底判断
  const prevDataLenRef = useRef(items.length);
  const prevTotalHeightRef = useRef(totalHeight);
  const prevScrollTopRef = useRef(0);

  // 实际 scrollTop（粘底时 = MAX）
  const actualScrollTop = useMemo(() => {
    if (isStickingToBottom) return SCROLL_TO_END;
    const maxScroll = Math.max(0, totalHeight - height);
    return Math.max(0, Math.min(scrollTop, maxScroll));
  }, [isStickingToBottom, scrollTop, totalHeight, height]);

  // 粘底逻辑：新内容到达 / 流式更新时自动跟随
  useEffect(() => {
    const maxScroll = Math.max(0, prevTotalHeightRef.current - height);
    const wasAtBottom = prevTotalHeightRef.current <= height ||
      prevScrollTopRef.current >= maxScroll - 1;
    const listGrew = items.length > prevDataLenRef.current;
    const contentGrew = totalHeight > prevTotalHeightRef.current;

    if ((listGrew || contentGrew) && (isStickingToBottom || wasAtBottom)) {
      setIsStickingToBottom(true);
      setScrollTop(SCROLL_TO_END);
    }

    prevDataLenRef.current = items.length;
    prevTotalHeightRef.current = totalHeight;
    if (!isStickingToBottom) {
      prevScrollTopRef.current = Math.min(scrollTop, Math.max(0, totalHeight - height));
    } else {
      prevScrollTopRef.current = Math.max(0, totalHeight - height);
    }
  }, [items.length, totalHeight, height, isStickingToBottom, scrollTop]);

  // ── 虚拟化：计算可见范围 ──
  const resolvedScrollTop = isStickingToBottom
    ? Math.max(0, totalHeight - height)
    : Math.max(0, Math.min(scrollTop, totalHeight - height));

  const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = useMemo(() => {
    if (items.length === 0) {
      return { startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 };
    }

    // 找到第一个可见项（二分查找）
    let lo = 0, hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid + 1]! <= resolvedScrollTop) lo = mid + 1;
      else hi = mid;
    }
    const start = Math.max(0, lo - 1); // 1 个缓冲项

    // 找到最后一个可见项
    const viewBottom = resolvedScrollTop + height;
    let end = start;
    while (end < items.length && offsets[end]! < viewBottom) end++;
    end = Math.min(items.length, end + 1); // 1 个缓冲项

    const topH = offsets[start] ?? 0;
    const bottomH = totalItemsHeight - (offsets[end] ?? totalItemsHeight);

    return { startIndex: start, endIndex: end, topSpacerHeight: topH, bottomSpacerHeight: Math.max(0, bottomH) };
  }, [items.length, offsets, resolvedScrollTop, height, totalItemsHeight]);

  // ── ScrollProvider 注册 ──
  const totalHeightRef = useRef(totalHeight);
  totalHeightRef.current = totalHeight;
  const heightRef = useRef(height);
  heightRef.current = height;
  const stickyRef = useRef(isStickingToBottom);
  stickyRef.current = isStickingToBottom;

  const scrollBy = useCallback((delta: number) => {
    const maxScroll = Math.max(0, totalHeightRef.current - heightRef.current);
    if (delta < 0) {
      // 向上滚动
      setIsStickingToBottom(false);
      setScrollTop(prev => {
        const current = prev >= SCROLL_TO_END ? maxScroll : Math.min(prev, maxScroll);
        return Math.max(0, current + delta);
      });
    } else {
      // 向下滚动
      setScrollTop(prev => {
        const current = stickyRef.current ? maxScroll : Math.min(prev, maxScroll);
        const next = current + delta;
        if (next >= maxScroll) {
          setIsStickingToBottom(true);
          return SCROLL_TO_END;
        }
        return next;
      });
    }
  }, []);

  const scrollToPos = useCallback((position: "top" | "bottom") => {
    if (position === "bottom") {
      setIsStickingToBottom(true);
      setScrollTop(SCROLL_TO_END);
    } else {
      setIsStickingToBottom(false);
      setScrollTop(0);
    }
  }, []);

  const getScrollState = useCallback(() => {
    const maxScroll = Math.max(0, totalHeight - height);
    const current = isStickingToBottom ? maxScroll : Math.min(scrollTop, maxScroll);
    return { scrollTop: current, scrollHeight: totalHeight, viewportHeight: height };
  }, [scrollTop, totalHeight, height, isStickingToBottom]);

  useScrollable("message-list", { getScrollState, scrollBy, scrollTo: scrollToPos });

  // ── 渲染可见项 ──
  const observedNodesRef = useRef<Set<DOMElement>>(new Set());

  // 同步 observer：观察新节点，取消观察旧节点
  useEffect(() => {
    const currentNodes = new Set<DOMElement>();
    for (let i = startIndex; i < endIndex; i++) {
      const key = getItemKey(items[i], i);
      const node = itemRefsMap.current.get(key);
      if (node) {
        currentNodes.add(node);
        nodeToKeyRef.current.set(node, key);
        if (!observedNodesRef.current.has(node)) {
          itemsObserver.observe(node);
        }
      }
    }
    for (const node of observedNodesRef.current) {
      if (!currentNodes.has(node)) {
        itemsObserver.unobserve(node);
        nodeToKeyRef.current.delete(node);
      }
    }
    observedNodesRef.current = currentNodes;
  });

  const visibleItems: React.ReactNode[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const item = items[i];
    const prevItem = i > 0 ? items[i - 1] : undefined;
    const key = getItemKey(item, i);
    visibleItems.push(
      <Box
        key={key}
        flexDirection="column"
        flexShrink={0}
        width="100%"
        ref={(el: DOMElement | null) => {
          if (el) {
            itemRefsMap.current.set(key, el);
            nodeToKeyRef.current.set(el, key);
            if (!observedNodesRef.current.has(el)) {
              itemsObserver.observe(el);
            }
          }
        }}
      >
        {renderItem(item, i, prevItem)}
      </Box>
    );
  }

  // 空状态
  if (items.length === 0 && !streamingContent) {
    return <Box height={height} />;
  }

  return (
    <Box
      overflowY="scroll"
      overflowX="hidden"
      scrollTop={actualScrollTop}
      scrollbarThumbColor="gray"
      width="100%"
      height={height}
      flexDirection="column"
      paddingRight={1}
    >
      <Box flexShrink={0} width="100%" flexDirection="column">
        {/* 顶部虚拟化占位 */}
        {topSpacerHeight > 0 && <Box height={topSpacerHeight} flexShrink={0} />}

        {/* 可见项 */}
        {visibleItems}

        {/* 底部虚拟化占位 */}
        {bottomSpacerHeight > 0 && <Box height={bottomSpacerHeight} flexShrink={0} />}

        {/* 流式内容 */}
        {streamingContent}
      </Box>
    </Box>
  );
}
