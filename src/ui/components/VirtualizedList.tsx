/**
 * 虚拟化列表组件（泛型版）
 *
 * 对齐 gemini-cli 的 VirtualizedList 实现：
 * - 泛型 <T> + keyExtractor + render props
 * - 外部 estimatedItemHeight 回调
 * - anchor-based 定位 + sticky-to-bottom
 * - 双 ResizeObserver（容器 + 项目）
 * - Ink fork 的 overflowY="scroll"（滚动位置由 spacer 高度 + copyMode 的 marginTop 表达）
 * - useBatchedScroll 批量滚动
 *
 * ⚠️ 曾经这里还写着 `+ scrollTop + scrollbarThumbColor`，并真的往 <Box> 上传了这两个
 * prop —— 但它们是 gemini-cli 旧 Box 的遗留，在当前 ink fork 下**完全无效**：
 *   - 渲染器读的是 `node.scrollTop`（DOMElement 字段，只由 ScrollBox 组件命令式写入，
 *     见 render-node-to-output.ts `let cur = node.scrollTop ?? 0`），从不读 style.scrollTop；
 *     applyStyles() 也没有处理这个 key。
 *   - `scrollbarThumbColor` 在整个 src/ink/ 里零命中，fork 不画滚动条。
 * 传了等于没传，所以移除它们是行为等价的（tsc 报错正是这么暴露出来的）。真正生效的
 * 滚动位置表达是下面的 topSpacerHeight / bottomSpacerHeight 与 copyMode 的 marginTop。
 */

import {
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useMemo,
  useCallback,
} from "react";
import React from "react";
import Box from "../../ink/components/Box.js";
import type { DOMElement } from "../../ink/dom.js";
import { ResizeObserver } from "../../ink/_vendor/resize-observer.js";
import { useBatchedScroll } from "../hooks/useBatchedScroll.ts";
import { quantize, SCROLL_QUANTUM } from "../utils/scroll-quantum.ts";

export const SCROLL_TO_ITEM_END = Number.MAX_SAFE_INTEGER;

type VirtualizedListProps<T> = {
  data: T[];
  renderItem: (info: { item: T; index: number }) => React.ReactElement;
  estimatedItemHeight: (index: number) => number;
  keyExtractor: (item: T, index: number) => string;
  initialScrollIndex?: number;
  initialScrollOffsetInIndex?: number;
  scrollbarThumbColor?: string;
  /** Copy Mode：禁用 Ink 滚动，改用 marginTop 偏移，让终端原生选择文本 */
  copyModeEnabled?: boolean;
  /** ST8：粘底状态变化回调（true=跟随底部，false=用户滚离暂停）。 */
  onStickyChange?: (sticky: boolean) => void;
};

export type VirtualizedListRef<T> = {
  scrollBy: (delta: number) => void;
  scrollTo: (offset: number) => void;
  scrollToEnd: () => void;
  scrollToIndex: (params: {
    index: number;
    viewOffset?: number;
    viewPosition?: number;
  }) => void;
  scrollToItem: (params: {
    item: T;
    viewOffset?: number;
    viewPosition?: number;
  }) => void;
  getScrollIndex: () => number;
  getScrollState: () => {
    scrollTop: number;
    scrollHeight: number;
    innerHeight: number;
  };
};

function findLastIndex<T>(
  array: T[],
  predicate: (value: T, index: number, obj: T[]) => unknown,
): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i], i, array)) {
      return i;
    }
  }
  return -1;
}

function VirtualizedList<T>(
  props: VirtualizedListProps<T>,
  ref: React.Ref<VirtualizedListRef<T>>,
) {
  const {
    data,
    renderItem,
    estimatedItemHeight,
    keyExtractor,
    initialScrollIndex,
    initialScrollOffsetInIndex,
    onStickyChange,
  } = props;

  const dataRef = useRef(data);
  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);

  // ── 锚点系统 ──
  const [scrollAnchor, setScrollAnchor] = useState(() => {
    const scrollToEnd =
      initialScrollIndex === SCROLL_TO_ITEM_END ||
      (typeof initialScrollIndex === "number" &&
        initialScrollIndex >= data.length - 1 &&
        initialScrollOffsetInIndex === SCROLL_TO_ITEM_END);

    if (scrollToEnd) {
      return {
        index: data.length > 0 ? data.length - 1 : 0,
        offset: SCROLL_TO_ITEM_END,
      };
    }

    if (typeof initialScrollIndex === "number") {
      return {
        index: Math.max(0, Math.min(data.length - 1, initialScrollIndex)),
        offset: initialScrollOffsetInIndex ?? 0,
      };
    }

    return { index: 0, offset: 0 };
  });

  const [isStickingToBottom, setIsStickingToBottom] = useState(() => {
    const scrollToEnd =
      initialScrollIndex === SCROLL_TO_ITEM_END ||
      (typeof initialScrollIndex === "number" &&
        initialScrollIndex >= data.length - 1 &&
        initialScrollOffsetInIndex === SCROLL_TO_ITEM_END);
    return scrollToEnd;
  });

  // ── 容器高度测量 ──
  const containerRef = useRef<DOMElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const itemRefs = useRef<Array<DOMElement | null>>([]);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const isInitialScrollSet = useRef(false);

  const containerObserverRef = useRef<ResizeObserver | null>(null);
  const nodeToKeyRef = useRef(new WeakMap<DOMElement, string>());

  const containerRefCallback = useCallback((node: DOMElement | null) => {
    containerObserverRef.current?.disconnect();
    containerRef.current = node;
    if (node) {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          setContainerHeight(Math.round(entry.contentRect.height));
        }
      });
      observer.observe(node);
      containerObserverRef.current = observer;
    }
  }, []);

  // ── 项目高度测量 ──
  const itemsObserver = useMemo(
    () =>
      new ResizeObserver((entries) => {
        setHeights((prev) => {
          let next: Record<string, number> | null = null;
          for (const entry of entries) {
            const key = nodeToKeyRef.current.get(entry.target);
            if (key !== undefined) {
              const height = Math.round(entry.contentRect.height);
              if (prev[key] !== height) {
                if (!next) {
                  next = { ...prev };
                }
                next[key] = height;
              }
            }
          }
          return next ?? prev;
        });
      }),
    [],
  );

  useLayoutEffect(
    () => () => {
      containerObserverRef.current?.disconnect();
      itemsObserver.disconnect();
    },
    [itemsObserver],
  );

  // ── 偏移量计算 ──
  const { totalHeight, offsets } = useMemo(() => {
    const offsets: number[] = [0];
    let totalHeight = 0;
    for (let i = 0; i < data.length; i++) {
      const key = keyExtractor(data[i], i);
      const height = heights[key] ?? estimatedItemHeight(i);
      totalHeight += height;
      offsets.push(totalHeight);
    }
    return { totalHeight, offsets };
  }, [heights, data, estimatedItemHeight, keyExtractor]);

  const scrollableContainerHeight = containerHeight;

  const getAnchorForScrollTop = useCallback(
    (
      scrollTop: number,
      offsets: number[],
    ): { index: number; offset: number } => {
      const index = findLastIndex(offsets, (offset) => offset <= scrollTop);
      if (index === -1) {
        return { index: 0, offset: 0 };
      }
      return { index, offset: scrollTop - offsets[index] };
    },
    [],
  );

  // ── 实际 scrollTop 计算 ──
  const actualScrollTop = useMemo(() => {
    const offset = offsets[scrollAnchor.index];
    if (typeof offset !== "number") {
      return 0;
    }

    if (scrollAnchor.offset === SCROLL_TO_ITEM_END) {
      const item = data[scrollAnchor.index];
      const key = item ? keyExtractor(item, scrollAnchor.index) : "";
      const itemHeight = heights[key] ?? 0;
      return offset + itemHeight - scrollableContainerHeight;
    }

    return offset + scrollAnchor.offset;
  }, [
    scrollAnchor,
    offsets,
    heights,
    scrollableContainerHeight,
    data,
    keyExtractor,
  ]);

  const scrollTop = isStickingToBottom
    ? Number.MAX_SAFE_INTEGER
    : actualScrollTop;

  // ST8：粘底状态变化时通知外部协调器（流式↔滚动状态机）。
  const prevStickyRef = useRef(isStickingToBottom);
  useEffect(() => {
    if (prevStickyRef.current !== isStickingToBottom) {
      prevStickyRef.current = isStickingToBottom;
      onStickyChange?.(isStickingToBottom);
    }
  }, [isStickingToBottom, onStickyChange]);

  // ── 粘底逻辑 ──
  const prevDataLength = useRef(data.length);
  const prevTotalHeight = useRef(totalHeight);
  const prevScrollTop = useRef(actualScrollTop);
  const prevContainerHeight = useRef(scrollableContainerHeight);

  useLayoutEffect(() => {
    const contentPreviouslyFit =
      prevTotalHeight.current <= prevContainerHeight.current;
    const wasScrolledToBottomPixels =
      prevScrollTop.current >=
      prevTotalHeight.current - prevContainerHeight.current - 1;
    const wasAtBottom = contentPreviouslyFit || wasScrolledToBottomPixels;

    if (wasAtBottom && actualScrollTop >= prevScrollTop.current) {
      setIsStickingToBottom(true);
    }

    const listGrew = data.length > prevDataLength.current;
    const containerChanged =
      prevContainerHeight.current !== scrollableContainerHeight;

    if (
      (listGrew && (isStickingToBottom || wasAtBottom)) ||
      (isStickingToBottom && containerChanged)
    ) {
      setScrollAnchor({
        index: data.length > 0 ? data.length - 1 : 0,
        offset: SCROLL_TO_ITEM_END,
      });
      if (!isStickingToBottom) {
        setIsStickingToBottom(true);
      }
    } else if (
      (scrollAnchor.index >= data.length ||
        actualScrollTop > totalHeight - scrollableContainerHeight) &&
      data.length > 0
    ) {
      const newScrollTop = Math.max(0, totalHeight - scrollableContainerHeight);
      setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
    } else if (data.length === 0) {
      setScrollAnchor({ index: 0, offset: 0 });
    }

    prevDataLength.current = data.length;
    prevTotalHeight.current = totalHeight;
    prevScrollTop.current = actualScrollTop;
    prevContainerHeight.current = scrollableContainerHeight;
  }, [
    data.length,
    totalHeight,
    actualScrollTop,
    scrollableContainerHeight,
    scrollAnchor.index,
    getAnchorForScrollTop,
    offsets,
    isStickingToBottom,
  ]);

  // ── 初始滚动位置 ──
  useLayoutEffect(() => {
    if (
      isInitialScrollSet.current ||
      offsets.length <= 1 ||
      totalHeight <= 0 ||
      containerHeight <= 0
    ) {
      return;
    }

    if (typeof initialScrollIndex === "number") {
      const scrollToEnd =
        initialScrollIndex === SCROLL_TO_ITEM_END ||
        (initialScrollIndex >= data.length - 1 &&
          initialScrollOffsetInIndex === SCROLL_TO_ITEM_END);

      if (scrollToEnd) {
        setScrollAnchor({
          index: data.length - 1,
          offset: SCROLL_TO_ITEM_END,
        });
        setIsStickingToBottom(true);
        isInitialScrollSet.current = true;
        return;
      }

      const index = Math.max(0, Math.min(data.length - 1, initialScrollIndex));
      const offset = initialScrollOffsetInIndex ?? 0;
      const newScrollTop = (offsets[index] ?? 0) + offset;

      const clampedScrollTop = Math.max(
        0,
        Math.min(totalHeight - scrollableContainerHeight, newScrollTop),
      );

      setScrollAnchor(getAnchorForScrollTop(clampedScrollTop, offsets));
      isInitialScrollSet.current = true;
    }
  }, [
    initialScrollIndex,
    initialScrollOffsetInIndex,
    offsets,
    totalHeight,
    containerHeight,
    getAnchorForScrollTop,
    data.length,
    heights,
    scrollableContainerHeight,
  ]);

  // ── 虚拟化：计算可见范围（滚动量化 P2-1） ──
  // 将用于“计算可见范围”的 scrollTop 量化到固定 bin，并在 bin 两侧各扩一个 quantum
  // 作为 overscan。由此：
  //   1) 该窗口恒为“精确视口覆盖范围”的超集 → 滚动中绝不会露出未挂载的空白行；
  //   2) 仅当 scrollTop 跨越 quantum 边界时窗口边界才变化 → 挂载集合稳定，
  //      减少 Yoga 布局 / ResizeObserver 抖动（高频滚动时收益明显）。
  // 视觉滚动仍由下方 Ink 容器的精确 scrollTop 驱动，保持平滑。
  const qTop = quantize(Math.max(0, actualScrollTop), SCROLL_QUANTUM);
  const windowTop = Math.max(0, qTop - SCROLL_QUANTUM);
  const windowBottom =
    qTop + SCROLL_QUANTUM + scrollableContainerHeight + SCROLL_QUANTUM;

  const startIndex = Math.max(
    0,
    findLastIndex(offsets, (offset) => offset <= windowTop) - 1,
  );
  const endIndexOffset = offsets.findIndex((offset) => offset > windowBottom);
  const endIndex =
    endIndexOffset === -1
      ? data.length - 1
      : Math.min(data.length - 1, endIndexOffset);

  const topSpacerHeight = offsets[startIndex] ?? 0;
  const bottomSpacerHeight =
    totalHeight - (offsets[endIndex + 1] ?? totalHeight);

  // ── 观察可见项 ──
  const observedNodes = useRef<Set<DOMElement>>(new Set());
  useLayoutEffect(() => {
    const currentNodes = new Set<DOMElement>();
    for (let i = startIndex; i <= endIndex; i++) {
      const node = itemRefs.current[i];
      const item = data[i];
      if (node && item) {
        currentNodes.add(node);
        const key = keyExtractor(item, i);
        nodeToKeyRef.current.set(node, key);
        if (!observedNodes.current.has(node)) {
          itemsObserver.observe(node);
        }
      }
    }
    for (const node of observedNodes.current) {
      if (!currentNodes.has(node)) {
        itemsObserver.unobserve(node);
        nodeToKeyRef.current.delete(node);
      }
    }
    observedNodes.current = currentNodes;
  });

  // ── 渲染可见项 ──
  const renderedItems = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const item = data[i];
    if (item) {
      renderedItems.push(
        <Box
          key={keyExtractor(item, i)}
          width="100%"
          flexDirection="column"
          flexShrink={0}
          ref={(el: DOMElement | null) => {
            itemRefs.current[i] = el;
          }}
        >
          {renderItem({ item, index: i })}
        </Box>,
      );
    }
  }

  // ── 批量滚动 ──
  const { getScrollTop, setPendingScrollTop } = useBatchedScroll(scrollTop);

  // ── 暴露 ref API ──
  useImperativeHandle(
    ref,
    () => ({
      scrollBy: (delta: number) => {
        if (delta < 0) {
          setIsStickingToBottom(false);
        }
        const currentScrollTop = getScrollTop();
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        const actualCurrent = Math.min(currentScrollTop, maxScroll);
        let newScrollTop = Math.max(0, actualCurrent + delta);
        if (newScrollTop >= maxScroll) {
          setIsStickingToBottom(true);
          newScrollTop = Number.MAX_SAFE_INTEGER;
        }
        setPendingScrollTop(newScrollTop);
        setScrollAnchor(
          getAnchorForScrollTop(Math.min(newScrollTop, maxScroll), offsets),
        );
      },
      scrollTo: (offset: number) => {
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        if (offset >= maxScroll || offset === SCROLL_TO_ITEM_END) {
          setIsStickingToBottom(true);
          setPendingScrollTop(Number.MAX_SAFE_INTEGER);
          if (data.length > 0) {
            setScrollAnchor({
              index: data.length - 1,
              offset: SCROLL_TO_ITEM_END,
            });
          }
        } else {
          setIsStickingToBottom(false);
          const newScrollTop = Math.max(0, offset);
          setPendingScrollTop(newScrollTop);
          setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
        }
      },
      scrollToEnd: () => {
        setIsStickingToBottom(true);
        setPendingScrollTop(Number.MAX_SAFE_INTEGER);
        if (data.length > 0) {
          setScrollAnchor({
            index: data.length - 1,
            offset: SCROLL_TO_ITEM_END,
          });
        }
      },
      scrollToIndex: ({
        index,
        viewOffset = 0,
        viewPosition = 0,
      }: {
        index: number;
        viewOffset?: number;
        viewPosition?: number;
      }) => {
        setIsStickingToBottom(false);
        const offset = offsets[index];
        if (offset !== undefined) {
          const maxScroll = Math.max(
            0,
            totalHeight - scrollableContainerHeight,
          );
          const newScrollTop = Math.max(
            0,
            Math.min(
              maxScroll,
              offset - viewPosition * scrollableContainerHeight + viewOffset,
            ),
          );
          setPendingScrollTop(newScrollTop);
          setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
        }
      },
      scrollToItem: ({
        item,
        viewOffset = 0,
        viewPosition = 0,
      }: {
        item: T;
        viewOffset?: number;
        viewPosition?: number;
      }) => {
        setIsStickingToBottom(false);
        const index = data.indexOf(item);
        if (index !== -1) {
          const offset = offsets[index];
          if (offset !== undefined) {
            const maxScroll = Math.max(
              0,
              totalHeight - scrollableContainerHeight,
            );
            const newScrollTop = Math.max(
              0,
              Math.min(
                maxScroll,
                offset - viewPosition * scrollableContainerHeight + viewOffset,
              ),
            );
            setPendingScrollTop(newScrollTop);
            setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
          }
        }
      },
      getScrollIndex: () => scrollAnchor.index,
      getScrollState: () => {
        const maxScroll = Math.max(0, totalHeight - containerHeight);
        return {
          scrollTop: Math.min(getScrollTop(), maxScroll),
          scrollHeight: totalHeight,
          innerHeight: containerHeight,
        };
      },
    }),
    [
      offsets,
      scrollAnchor,
      totalHeight,
      getAnchorForScrollTop,
      data,
      scrollableContainerHeight,
      getScrollTop,
      setPendingScrollTop,
      containerHeight,
    ],
  );

  // Copy Mode：禁用 Ink 滚动管理，改用 marginTop 偏移
  // 这样终端可以原生选中文本（Ink 的 overflowY="scroll" 会接管渲染区域导致无法选中）
  const copyMode = props.copyModeEnabled ?? false;

  return (
    <Box
      ref={containerRefCallback}
      overflowY={copyMode ? "hidden" : "scroll"}
      overflowX="hidden"
      width="100%"
      height="100%"
      flexDirection="column"
      paddingRight={copyMode ? 0 : 1}
    >
      <Box
        flexShrink={0}
        width="100%"
        flexDirection="column"
        marginTop={copyMode ? -actualScrollTop : 0}
      >
        <Box height={topSpacerHeight} flexShrink={0} />
        {renderedItems}
        <Box height={bottomSpacerHeight} flexShrink={0} />
      </Box>
    </Box>
  );
}

// forwardRef 泛型包装
const VirtualizedListWithForwardRef = forwardRef(VirtualizedList) as <T>(
  props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef<T>> },
) => React.ReactElement;

export { VirtualizedListWithForwardRef as VirtualizedList };

VirtualizedList.displayName = "VirtualizedList";
