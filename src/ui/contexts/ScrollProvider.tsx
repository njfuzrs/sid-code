/**
 * 统一滚动管理（对齐 gemini-cli）
 *
 * 核心改动（vs 旧实现）：
 * - getBoundingBox() 空间检测替代简单 activeId
 * - 完整鼠标事件支持：滚轮/点击轨道/拖拽 thumb
 * - setTimeout(0) 批量滚动（per-component 累积）
 * - canScroll(direction) 方向检测
 * - 最小面积优先（处理嵌套滚动区域）
 *
 * 参考 gemini-cli/packages/cli/src/ui/contexts/ScrollProvider.tsx
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getBoundingBox, type DOMElement } from "ink";
import { useMouse, type MouseEvent } from "./MouseContext.tsx";

export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  innerHeight: number;
}

export interface ScrollableEntry {
  id: string;
  ref: React.RefObject<DOMElement>;
  getScrollState: () => ScrollState;
  scrollBy: (delta: number) => void;
  scrollTo?: (scrollTop: number, duration?: number) => void;
  hasFocus: () => boolean;
  flashScrollbar: () => void;
}

interface ScrollContextType {
  register: (entry: ScrollableEntry) => void;
  unregister: (id: string) => void;
  getFocusedEntry: () => ScrollableEntry | null;
}

const ScrollContext = createContext<ScrollContextType | null>(null);

/** 根据鼠标坐标查找候选滚动区域，按面积从小到大排序（最内层优先） */
const findScrollableCandidates = (
  mouseEvent: MouseEvent,
  scrollables: Map<string, ScrollableEntry>,
) => {
  const candidates: Array<ScrollableEntry & { area: number }> = [];

  for (const entry of scrollables.values()) {
    if (!entry.ref.current) continue;

    const boundingBox = getBoundingBox(entry.ref.current);
    if (!boundingBox) continue;

    const { x, y, width, height } = boundingBox;

    // +1 宽度包含滚动条列
    const isInside =
      mouseEvent.col >= x &&
      mouseEvent.col < x + width + 1 &&
      mouseEvent.row >= y &&
      mouseEvent.row < y + height;

    if (isInside) {
      candidates.push({ ...entry, area: width * height });
    }
  }

  // 最小面积优先（最内层嵌套区域）
  candidates.sort((a, b) => a.area - b.area);
  return candidates;
};

export const ScrollProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [scrollables, setScrollables] = useState(
    new Map<string, ScrollableEntry>(),
  );

  const register = useCallback((entry: ScrollableEntry) => {
    setScrollables((prev) => new Map(prev).set(entry.id, entry));
  }, []);

  const unregister = useCallback((id: string) => {
    setScrollables((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const scrollablesRef = useRef(scrollables);
  useEffect(() => {
    scrollablesRef.current = scrollables;
  }, [scrollables]);

  // per-component 批量滚动累积
  const pendingScrollsRef = useRef(new Map<string, number>());
  const flushScheduledRef = useRef(false);

  // 滚动条拖拽状态
  const dragStateRef = useRef<{
    active: boolean;
    id: string | null;
    offset: number;
  }>({
    active: false,
    id: null,
    offset: 0,
  });

  const scheduleFlush = useCallback(() => {
    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      setTimeout(() => {
        flushScheduledRef.current = false;
        for (const [id, delta] of pendingScrollsRef.current.entries()) {
          const entry = scrollablesRef.current.get(id);
          if (entry) {
            entry.scrollBy(delta);
          }
        }
        pendingScrollsRef.current.clear();
      }, 0);
    }
  }, []);

  /** 处理鼠标滚轮 */
  const handleScroll = (direction: "up" | "down", mouseEvent: MouseEvent) => {
    const delta = direction === "up" ? -1 : 1;
    const candidates = findScrollableCandidates(
      mouseEvent,
      scrollablesRef.current,
    );

    for (const candidate of candidates) {
      const { scrollTop, scrollHeight, innerHeight } =
        candidate.getScrollState();
      const pendingDelta = pendingScrollsRef.current.get(candidate.id) || 0;
      const effectiveScrollTop = scrollTop + pendingDelta;

      // 浮点精度容差
      const canScrollUp = effectiveScrollTop > 0.001;
      const canScrollDown =
        effectiveScrollTop < scrollHeight - innerHeight - 0.001;

      if (direction === "up" && canScrollUp) {
        pendingScrollsRef.current.set(candidate.id, pendingDelta + delta);
        scheduleFlush();
        return true;
      }

      if (direction === "down" && canScrollDown) {
        pendingScrollsRef.current.set(candidate.id, pendingDelta + delta);
        scheduleFlush();
        return true;
      }
    }
    return false;
  };

  /** 处理鼠标左键按下（滚动条交互） */
  const handleLeftPress = (mouseEvent: MouseEvent) => {
    for (const entry of scrollablesRef.current.values()) {
      if (!entry.ref.current || !entry.hasFocus()) continue;

      const boundingBox = getBoundingBox(entry.ref.current);
      if (!boundingBox) continue;

      const { x, y, width, height } = boundingBox;

      // 检查点击是否在滚动条列（x + width）
      if (
        mouseEvent.col === x + width &&
        mouseEvent.row >= y &&
        mouseEvent.row < y + height
      ) {
        const { scrollTop, scrollHeight, innerHeight } = entry.getScrollState();

        if (scrollHeight <= innerHeight) continue;

        const thumbHeight = Math.max(
          1,
          Math.floor((innerHeight / scrollHeight) * innerHeight),
        );
        const maxScrollTop = scrollHeight - innerHeight;
        const maxThumbY = innerHeight - thumbHeight;

        if (maxThumbY <= 0) continue;

        const currentThumbY = Math.round(
          (scrollTop / maxScrollTop) * maxThumbY,
        );

        const absoluteThumbTop = y + currentThumbY;
        const absoluteThumbBottom = absoluteThumbTop + thumbHeight;

        // 边缘扩展命中区域
        const isTop = mouseEvent.row === y;
        const isBottom = mouseEvent.row === y + height - 1;

        const hitTop = isTop ? absoluteThumbTop : absoluteThumbTop - 1;
        const hitBottom = isBottom
          ? absoluteThumbBottom
          : absoluteThumbBottom + 1;

        const isThumbClick =
          mouseEvent.row >= hitTop && mouseEvent.row < hitBottom;

        let offset = 0;
        const relativeMouseY = mouseEvent.row - y;

        if (isThumbClick) {
          // 拖拽 thumb：记录偏移量
          offset = relativeMouseY - currentThumbY;
        } else {
          // 轨道点击：跳转到位置，thumb 居中于点击位置
          const targetThumbY = Math.max(
            0,
            Math.min(maxThumbY, relativeMouseY - Math.floor(thumbHeight / 2)),
          );

          const newScrollTop = Math.round(
            (targetThumbY / maxThumbY) * maxScrollTop,
          );
          if (entry.scrollTo) {
            entry.scrollTo(newScrollTop);
          } else {
            entry.scrollBy(newScrollTop - scrollTop);
          }

          offset = relativeMouseY - targetThumbY;
        }

        // 开始拖拽
        dragStateRef.current = {
          active: true,
          id: entry.id,
          offset,
        };
        return true;
      }
    }

    // 非滚动条区域点击：闪烁最内层候选的滚动条
    const candidates = findScrollableCandidates(
      mouseEvent,
      scrollablesRef.current,
    );

    if (candidates.length > 0) {
      candidates[0].flashScrollbar();
      return false;
    }
    return false;
  };

  /** 处理鼠标移动（拖拽滚动条） */
  const handleMove = (mouseEvent: MouseEvent) => {
    const state = dragStateRef.current;
    if (!state.active || !state.id) return false;

    const entry = scrollablesRef.current.get(state.id);
    if (!entry || !entry.ref.current) {
      state.active = false;
      return false;
    }

    const boundingBox = getBoundingBox(entry.ref.current);
    if (!boundingBox) return false;

    const { y } = boundingBox;
    const { scrollTop, scrollHeight, innerHeight } = entry.getScrollState();

    const thumbHeight = Math.max(
      1,
      Math.floor((innerHeight / scrollHeight) * innerHeight),
    );
    const maxScrollTop = scrollHeight - innerHeight;
    const maxThumbY = innerHeight - thumbHeight;

    if (maxThumbY <= 0) return false;

    const relativeMouseY = mouseEvent.row - y;
    const targetThumbY = Math.max(
      0,
      Math.min(maxThumbY, relativeMouseY - state.offset),
    );

    const targetScrollTop = Math.round(
      (targetThumbY / maxThumbY) * maxScrollTop,
    );

    if (entry.scrollTo) {
      entry.scrollTo(targetScrollTop, 0);
    } else {
      entry.scrollBy(targetScrollTop - scrollTop);
    }
    return true;
  };

  /** 处理鼠标左键释放（结束拖拽） */
  const handleLeftRelease = () => {
    if (dragStateRef.current.active) {
      dragStateRef.current = {
        active: false,
        id: null,
        offset: 0,
      };
      return true;
    }
    return false;
  };

  // 注册鼠标事件处理
  useMouse(
    useCallback((event: MouseEvent) => {
      if (event.name === "scroll-up") {
        return handleScroll("up", event);
      } else if (event.name === "scroll-down") {
        return handleScroll("down", event);
      } else if (event.name === "left-press") {
        return handleLeftPress(event);
      } else if (event.name === "move") {
        return handleMove(event);
      } else if (event.name === "left-release") {
        return handleLeftRelease();
      }
      return false;
    }, []),
    { isActive: true },
  );

  const getFocusedEntry = useCallback((): ScrollableEntry | null => {
    for (const entry of scrollablesRef.current.values()) {
      if (entry.hasFocus()) return entry;
    }
    // 没有焦点的，返回第一个
    const first = scrollablesRef.current.values().next();
    return first.done ? null : first.value;
  }, []);

  const contextValue = useMemo(
    () => ({ register, unregister, getFocusedEntry }),
    [register, unregister, getFocusedEntry],
  );

  return (
    <ScrollContext.Provider value={contextValue}>
      {children}
    </ScrollContext.Provider>
  );
};

let nextId = 0;

/**
 * 注册可滚动区域到 ScrollProvider
 *
 * @param entry - 滚动区域入口（不含 id，自动生成）
 * @param isActive - 是否激活注册
 */
export const useScrollable = (
  entry: Omit<ScrollableEntry, "id">,
  isActive: boolean,
) => {
  const context = useContext(ScrollContext);
  if (!context) {
    throw new Error("useScrollable 必须在 ScrollProvider 内使用");
  }

  const [id] = useState(() => `scrollable-${nextId++}`);

  useEffect(() => {
    if (isActive) {
      context.register({ ...entry, id });
      return () => {
        context.unregister(id);
      };
    }
    return;
  }, [context, entry, id, isActive]);
};

/**
 * 获取滚动状态和控制方法（供 App 级组件使用）
 *
 * - getScrollState(): 返回当前焦点 scrollable 的滚动百分比
 * - scrollActive(action): 对焦点 scrollable 执行滚动操作
 */
export function useScrollState() {
  const context = useContext(ScrollContext);
  if (!context) {
    throw new Error("useScrollState 必须在 ScrollProvider 内使用");
  }

  const getScrollState = useCallback((): { percent: number } | null => {
    const entry = context.getFocusedEntry?.();
    if (!entry) return null;
    const { scrollTop, scrollHeight, innerHeight } = entry.getScrollState();
    if (scrollHeight <= innerHeight) return { percent: 100 };
    const maxScroll = scrollHeight - innerHeight;
    const percent = Math.round(Math.min(100, (scrollTop / maxScroll) * 100));
    return { percent };
  }, [context]);

  const scrollActive = useCallback((action: "pageup" | "pagedown" | "up" | "down" | "top" | "bottom") => {
    const entry = context.getFocusedEntry?.();
    if (!entry) return;
    const { scrollTop, scrollHeight, innerHeight } = entry.getScrollState();
    const maxScroll = Math.max(0, scrollHeight - innerHeight);

    switch (action) {
      case "up":
        entry.scrollBy(-1);
        break;
      case "down":
        entry.scrollBy(1);
        break;
      case "pageup":
        entry.scrollBy(-Math.max(1, innerHeight - 1));
        break;
      case "pagedown":
        entry.scrollBy(Math.max(1, innerHeight - 1));
        break;
      case "top":
        if (entry.scrollTo) entry.scrollTo(0);
        else entry.scrollBy(-scrollTop);
        break;
      case "bottom":
        if (entry.scrollTo) entry.scrollTo(maxScroll);
        else entry.scrollBy(maxScroll - scrollTop);
        break;
    }
  }, [context]);

  return { getScrollState, scrollActive };
}
