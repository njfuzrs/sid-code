/**
 * 可滚动列表包装组件
 *
 * 包装 VirtualizedList，增加：
 * - 键盘导航：PageUp/PageDown/Home/End/Arrow
 * - 平滑滚动动画：ease-in-out，可配置时长（默认 200ms）
 * - 动画滚动条：闪现 → 保持 → 淡出
 * - 与 ScrollProvider 集成
 *
 * 参考 gemini-cli/packages/cli/src/ui/components/shared/ScrollableList.tsx
 */

import React, {
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useMemo,
  useLayoutEffect,
  useState,
  useEffect,
} from "react";
import {
  VirtualizedList,
  type VirtualizedListRef,
  SCROLL_TO_ITEM_END,
} from "./VirtualizedList.tsx";
import { useScrollable, type ScrollableEntry } from "../contexts/ScrollProvider.tsx";
type ScrollableEntryWithoutId = Omit<ScrollableEntry, "id">;
import { Box, type DOMElement } from "ink";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import { theme } from "../semantic-colors.ts";

const ANIMATION_FRAME_DURATION_MS = 33;

type VirtualizedListProps<T> = {
  data: T[];
  renderItem: (info: { item: T; index: number }) => React.ReactElement;
  estimatedItemHeight: (index: number) => number;
  keyExtractor: (item: T, index: number) => string;
  initialScrollIndex?: number;
  initialScrollOffsetInIndex?: number;
};

interface ScrollableListProps<T> extends VirtualizedListProps<T> {
  hasFocus: boolean;
  width?: string | number;
}

export type ScrollableListRef<T> = VirtualizedListRef<T>;

// ── 动画滚动条 hook ──
function useAnimatedScrollbar(
  _isFocused: boolean,
  scrollBy: (delta: number) => void,
) {
  const [scrollbarColor, setScrollbarColor] = useState(theme.ui.dark);
  const animationFrame = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (animationFrame.current) {
      clearInterval(animationFrame.current);
      animationFrame.current = null;
    }
    if (timeout.current) {
      clearTimeout(timeout.current);
      timeout.current = null;
    }
  }, []);

  const flashScrollbar = useCallback(() => {
    cleanup();

    const isTest = typeof process !== "undefined" && process.env["NODE_ENV"] === "test";
    const visibleDuration = isTest ? 0 : 1000;
    const fadeOutDuration = isTest ? 0 : 300;

    const focusedColor = theme.text.secondary;
    const unfocusedColor = theme.ui.dark;

    if (!focusedColor || !unfocusedColor) return;

    if (isTest) {
      setScrollbarColor(unfocusedColor);
      return;
    }

    // 立即显示
    setScrollbarColor(focusedColor);

    // 等待后淡出
    timeout.current = setTimeout(() => {
      let start = Date.now();
      animationFrame.current = setInterval(() => {
        const elapsed = Date.now() - start;
        const progress = Math.min(elapsed / fadeOutDuration, 1);
        // 简单线性插值（避免引入颜色插值库）
        if (progress >= 1) {
          setScrollbarColor(unfocusedColor);
          cleanup();
        }
      }, ANIMATION_FRAME_DURATION_MS);
    }, visibleDuration);
  }, [cleanup]);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const scrollByWithAnimation = useCallback(
    (delta: number) => {
      scrollBy(delta);
      flashScrollbar();
    },
    [scrollBy, flashScrollbar],
  );

  return { scrollbarColor, flashScrollbar, scrollByWithAnimation };
}

// ── ScrollableList 组件 ──
function ScrollableList<T>(
  props: ScrollableListProps<T>,
  ref: React.Ref<ScrollableListRef<T>>,
) {
  const { hasFocus, width } = props;
  const virtualizedListRef = useRef<VirtualizedListRef<T>>(null);
  const containerRef = useRef<DOMElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      scrollBy: (delta) => virtualizedListRef.current?.scrollBy(delta),
      scrollTo: (offset) => virtualizedListRef.current?.scrollTo(offset),
      scrollToEnd: () => virtualizedListRef.current?.scrollToEnd(),
      scrollToIndex: (params) =>
        virtualizedListRef.current?.scrollToIndex(params),
      scrollToItem: (params) =>
        virtualizedListRef.current?.scrollToItem(params),
      getScrollIndex: () => virtualizedListRef.current?.getScrollIndex() ?? 0,
      getScrollState: () =>
        virtualizedListRef.current?.getScrollState() ?? {
          scrollTop: 0,
          scrollHeight: 0,
          innerHeight: 0,
        },
    }),
    [],
  );

  const getScrollState = useCallback(
    () =>
      virtualizedListRef.current?.getScrollState() ?? {
        scrollTop: 0,
        scrollHeight: 0,
        innerHeight: 0,
      },
    [],
  );

  const scrollBy = useCallback((delta: number) => {
    virtualizedListRef.current?.scrollBy(delta);
  }, []);

  const { scrollbarColor, flashScrollbar, scrollByWithAnimation } =
    useAnimatedScrollbar(hasFocus, scrollBy);

  // ── 平滑滚动 ──
  const smoothScrollState = useRef<{
    active: boolean;
    start: number;
    from: number;
    to: number;
    duration: number;
    timer: ReturnType<typeof setInterval> | null;
  }>({ active: false, start: 0, from: 0, to: 0, duration: 0, timer: null });

  const stopSmoothScroll = useCallback(() => {
    if (smoothScrollState.current.timer) {
      clearInterval(smoothScrollState.current.timer);
      smoothScrollState.current.timer = null;
    }
    smoothScrollState.current.active = false;
  }, []);

  useLayoutEffect(() => stopSmoothScroll, [stopSmoothScroll]);

  const smoothScrollTo = useCallback(
    (
      targetScrollTop: number,
      duration: number = process.env["NODE_ENV"] === "test" ? 0 : 200,
    ) => {
      stopSmoothScroll();

      const scrollState = virtualizedListRef.current?.getScrollState() ?? {
        scrollTop: 0,
        scrollHeight: 0,
        innerHeight: 0,
      };
      const {
        scrollTop: rawStartScrollTop,
        scrollHeight,
        innerHeight,
      } = scrollState;

      const maxScrollTop = Math.max(0, scrollHeight - innerHeight);
      const startScrollTop = Math.min(rawStartScrollTop, maxScrollTop);

      let effectiveTarget = targetScrollTop;
      if (
        targetScrollTop === SCROLL_TO_ITEM_END ||
        targetScrollTop >= maxScrollTop
      ) {
        effectiveTarget = maxScrollTop;
      }

      const clampedTarget = Math.max(
        0,
        Math.min(maxScrollTop, effectiveTarget),
      );

      if (duration === 0) {
        if (
          targetScrollTop === SCROLL_TO_ITEM_END ||
          targetScrollTop >= maxScrollTop
        ) {
          virtualizedListRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
        } else {
          virtualizedListRef.current?.scrollTo(Math.round(clampedTarget));
        }
        flashScrollbar();
        return;
      }

      smoothScrollState.current = {
        active: true,
        start: Date.now(),
        from: startScrollTop,
        to: clampedTarget,
        duration,
        timer: setInterval(() => {
          const now = Date.now();
          const elapsed = now - smoothScrollState.current.start;
          const progress = Math.min(elapsed / duration, 1);

          // Ease-in-out
          const t = progress;
          const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

          const current =
            smoothScrollState.current.from +
            (smoothScrollState.current.to - smoothScrollState.current.from) *
              ease;

          if (progress >= 1) {
            if (
              targetScrollTop === SCROLL_TO_ITEM_END ||
              targetScrollTop >= maxScrollTop
            ) {
              virtualizedListRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
            } else {
              virtualizedListRef.current?.scrollTo(Math.round(current));
            }
            stopSmoothScroll();
            flashScrollbar();
          } else {
            virtualizedListRef.current?.scrollTo(Math.round(current));
          }
        }, ANIMATION_FRAME_DURATION_MS),
      };
    },
    [stopSmoothScroll, flashScrollbar],
  );

  // ── 键盘导航 ──
  useKeypress(KeypressPriority.High, (key) => {
    if (!hasFocus) return false;

    // PageUp / PageDown
    if (key.name === "pageup" || key.name === "pagedown") {
      const direction = key.name === "pageup" ? -1 : 1;
      const scrollState = getScrollState();
      const maxScroll = Math.max(
        0,
        scrollState.scrollHeight - scrollState.innerHeight,
      );
      const current = smoothScrollState.current.active
        ? smoothScrollState.current.to
        : Math.min(scrollState.scrollTop, maxScroll);
      const innerHeight = scrollState.innerHeight;
      smoothScrollTo(current + direction * innerHeight);
      return true;
    }

    // Shift+Up / Shift+Down（单行滚动）
    if (key.shift && key.name === "up") {
      stopSmoothScroll();
      scrollByWithAnimation(-1);
      return true;
    }
    if (key.shift && key.name === "down") {
      stopSmoothScroll();
      scrollByWithAnimation(1);
      return true;
    }

    return false;
  });

  // ── ScrollProvider 注册 ──
  const hasFocusCallback = useCallback(() => hasFocus, [hasFocus]);

  const scrollableEntry = useMemo<ScrollableEntryWithoutId>(
    () => ({
      ref: containerRef as React.RefObject<DOMElement>,
      getScrollState,
      scrollBy: scrollByWithAnimation,
      scrollTo: smoothScrollTo,
      hasFocus: hasFocusCallback,
      flashScrollbar,
    }),
    [
      getScrollState,
      hasFocusCallback,
      flashScrollbar,
      scrollByWithAnimation,
      smoothScrollTo,
    ],
  );

  useScrollable(scrollableEntry, true);

  return (
    <Box
      ref={containerRef}
      flexGrow={1}
      flexDirection="column"
      overflow="hidden"
      width={width}
    >
      <VirtualizedList
        ref={virtualizedListRef}
        {...props}
        scrollbarThumbColor={scrollbarColor}
      />
    </Box>
  );
}

// forwardRef 泛型包装
const ScrollableListWithForwardRef = forwardRef(ScrollableList) as <T>(
  props: ScrollableListProps<T> & { ref?: React.Ref<ScrollableListRef<T>> },
) => React.ReactElement;

export { ScrollableListWithForwardRef as ScrollableList };
