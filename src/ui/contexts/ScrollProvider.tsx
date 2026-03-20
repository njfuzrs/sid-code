/**
 * 统一滚动管理
 *
 * 注册表模式管理多个可滚动区域，鼠标滚轮/键盘滚动事件路由到活跃区域。
 * 批量滚动：queueMicrotask 合并同帧多次滚动。
 *
 * 支持两种注册方式：
 * 1. useScrollable(id, callbacks) — 旧接口，兼容 App.tsx 直接使用
 * 2. useScrollable(entry, isActive) — 新接口，ScrollableList 对象式注册
 *
 * 坐标系说明（scrollTop 语义）：
 * scrollTop = 从顶部向下偏移的行数（0 = 顶部）
 * "up"（向上滚动查看历史）= 减小 scrollTop = 负 delta
 * "down"（向下滚动回到底部）= 增大 scrollTop = 正 delta
 */

import React, { createContext, useContext, useCallback, useRef, useEffect, useMemo } from "react";
import type { DOMElement } from "ink";

/** 可滚动区域接口（内部统一格式） */
export interface ScrollableArea {
  id: string;
  getScrollState: () => { scrollTop: number; scrollHeight: number; viewportHeight: number };
  scrollBy: (delta: number) => void;
  scrollTo: (position: "top" | "bottom" | number) => void;
}

/** ScrollableList 注册入口（新接口） */
export interface ScrollableEntry {
  ref: React.RefObject<DOMElement>;
  getScrollState: () => { scrollTop: number; scrollHeight: number; innerHeight: number };
  scrollBy: (delta: number) => void;
  scrollTo: (offset: number) => void;
  hasFocus: () => boolean;
  flashScrollbar: () => void;
}

interface ScrollContextValue {
  registerArea: (area: ScrollableArea) => void;
  unregisterArea: (id: string) => void;
  /** 切换活跃滚动区域 */
  setActiveArea: (id: string) => void;
  /** 获取活跃区域的滚动状态 */
  getActiveScrollState: () => { scrollTop: number; scrollHeight: number; viewportHeight: number; percent: number } | null;
  /** 向活跃区域发送滚动指令 */
  scrollActive: (action: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom") => void;
}

const ScrollCtx = createContext<ScrollContextValue | null>(null);

let nextAreaId = 0;

export function ScrollProvider({ children }: { children: React.ReactNode }) {
  const areasRef = useRef<Map<string, ScrollableArea>>(new Map());
  /** 当前活跃区域 ID（默认第一个注册的） */
  const activeIdRef = useRef<string | null>(null);
  /** 批量滚动累积 */
  const pendingDeltaRef = useRef(0);
  const flushScheduledRef = useRef(false);

  const registerArea = useCallback((area: ScrollableArea) => {
    areasRef.current.set(area.id, area);
    if (!activeIdRef.current) activeIdRef.current = area.id;
  }, []);

  const unregisterArea = useCallback((id: string) => {
    areasRef.current.delete(id);
    if (activeIdRef.current === id) {
      const first = areasRef.current.keys().next().value;
      activeIdRef.current = first ?? null;
    }
  }, []);

  const setActiveArea = useCallback((id: string) => {
    if (areasRef.current.has(id)) {
      activeIdRef.current = id;
    }
  }, []);

  const getActiveArea = useCallback((): ScrollableArea | null => {
    if (!activeIdRef.current) return null;
    return areasRef.current.get(activeIdRef.current) ?? null;
  }, []);

  const flushScroll = useCallback(() => {
    flushScheduledRef.current = false;
    const delta = pendingDeltaRef.current;
    pendingDeltaRef.current = 0;
    if (delta === 0) return;
    const area = getActiveArea();
    area?.scrollBy(delta);
  }, [getActiveArea]);

  const getActiveScrollState = useCallback(() => {
    const area = getActiveArea();
    if (!area) return null;
    const state = area.getScrollState();
    const maxScroll = Math.max(0, state.scrollHeight - state.viewportHeight);
    const percent = maxScroll <= 0 ? 100 : Math.round((state.scrollTop / maxScroll) * 100);
    return { ...state, percent };
  }, [getActiveArea]);

  const scrollActive = useCallback((action: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom") => {
    const area = getActiveArea();
    if (!area) return;

    if (action === "top" || action === "bottom") {
      pendingDeltaRef.current = 0;
      area.scrollTo(action);
      return;
    }

    const state = area.getScrollState();
    const pageLines = Math.max(1, state.viewportHeight - 2);
    let delta = 0;
    switch (action) {
      case "up": delta = -3; break;
      case "down": delta = 3; break;
      case "pageup": delta = -pageLines; break;
      case "pagedown": delta = pageLines; break;
    }

    pendingDeltaRef.current += delta;
    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      queueMicrotask(flushScroll);
    }
  }, [getActiveArea, flushScroll]);

  const contextValue = useMemo(() => ({
    registerArea, unregisterArea, setActiveArea, getActiveScrollState, scrollActive,
  }), [registerArea, unregisterArea, setActiveArea, getActiveScrollState, scrollActive]);

  return (
    <ScrollCtx.Provider value={contextValue}>
      {children}
    </ScrollCtx.Provider>
  );
}

/**
 * 注册一个可滚动区域
 *
 * 重载 1（旧接口）：useScrollable(id, callbacks)
 * 重载 2（新接口）：useScrollable(entry, isActive) — ScrollableList 使用
 */
export function useScrollable(
  idOrEntry: string | ScrollableEntry,
  callbacksOrIsActive?: {
    getScrollState: () => { scrollTop: number; scrollHeight: number; viewportHeight: number };
    scrollBy: (delta: number) => void;
    scrollTo: (position: "top" | "bottom") => void;
  } | boolean,
): void {
  const ctx = useContext(ScrollCtx);
  if (!ctx) throw new Error("useScrollable 必须在 ScrollProvider 内使用");

  // 新接口：ScrollableEntry 对象
  if (typeof idOrEntry === "object") {
    const entry = idOrEntry;
    const isActive = callbacksOrIsActive === true;
    const idRef = useRef(`scrollable-${nextAreaId++}`);

    const entryRef = useRef(entry);
    entryRef.current = entry;

    useEffect(() => {
      const id = idRef.current;
      const area: ScrollableArea = {
        id,
        getScrollState: () => {
          const s = entryRef.current.getScrollState();
          return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, viewportHeight: s.innerHeight };
        },
        scrollBy: (delta) => entryRef.current.scrollBy(delta),
        scrollTo: (pos) => {
          if (pos === "top") entryRef.current.scrollTo(0);
          else if (pos === "bottom") entryRef.current.scrollTo(Number.MAX_SAFE_INTEGER);
          else entryRef.current.scrollTo(pos);
        },
      };
      ctx.registerArea(area);
      if (isActive) ctx.setActiveArea(id);
      return () => ctx.unregisterArea(id);
    }, [ctx, isActive]);

    return;
  }

  // 旧接口：id + callbacks
  const id = idOrEntry;
  const callbacks = callbacksOrIsActive as {
    getScrollState: () => { scrollTop: number; scrollHeight: number; viewportHeight: number };
    scrollBy: (delta: number) => void;
    scrollTo: (position: "top" | "bottom") => void;
  };

  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    const area: ScrollableArea = {
      id,
      getScrollState: () => cbRef.current.getScrollState(),
      scrollBy: (delta) => cbRef.current.scrollBy(delta),
      scrollTo: (pos) => cbRef.current.scrollTo(pos as "top" | "bottom"),
    };
    ctx.registerArea(area);
    return () => ctx.unregisterArea(id);
  }, [ctx, id]);
}

/** 获取滚动状态（供 StatusBar 等使用）— 返回稳定引用 */
export function useScrollState() {
  const ctx = useContext(ScrollCtx);
  const getScrollState = useCallback(() => {
    return ctx?.getActiveScrollState() ?? null;
  }, [ctx]);
  const scrollActive = useCallback((action: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom") => {
    ctx?.scrollActive(action);
  }, [ctx]);
  return useMemo(() => ({ getScrollState, scrollActive }), [getScrollState, scrollActive]);
}
