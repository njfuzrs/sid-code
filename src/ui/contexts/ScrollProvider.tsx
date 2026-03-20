/**
 * 统一滚动管理
 *
 * 注册表模式管理多个可滚动区域，鼠标滚轮/键盘滚动事件路由到活跃区域。
 * 批量滚动：queueMicrotask 合并同帧多次滚动。
 *
 * 坐标系说明（scrollTop 语义）：
 * scrollTop = 从顶部向下偏移的行数（0 = 顶部）
 * "up"（向上滚动查看历史）= 减小 scrollTop = 负 delta
 * "down"（向下滚动回到底部）= 增大 scrollTop = 正 delta
 */

import React, { createContext, useContext, useCallback, useRef, useEffect, useMemo } from "react";

/** 可滚动区域接口 */
export interface ScrollableArea {
  id: string;
  getScrollState: () => { scrollTop: number; scrollHeight: number; viewportHeight: number };
  scrollBy: (delta: number) => void;
  scrollTo: (position: "top" | "bottom") => void;
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
    // scrollTop=maxScroll 表示在底部（100%），scrollTop=0 表示在顶部（0%）
    const percent = maxScroll <= 0 ? 100 : Math.round((state.scrollTop / maxScroll) * 100);
    return { ...state, percent };
  }, [getActiveArea]);

  const scrollActive = useCallback((action: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom") => {
    const area = getActiveArea();
    if (!area) return;

    if (action === "top" || action === "bottom") {
      // 立即执行，不合并
      pendingDeltaRef.current = 0;
      area.scrollTo(action);
      return;
    }

    const state = area.getScrollState();
    const pageLines = Math.max(1, state.viewportHeight - 2);
    // scrollTop 语义："up"（查看历史）= 负 delta，"down"（回到底部）= 正 delta
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

  // useMemo 包裹 context value，避免不必要的 consumer 重渲染
  const contextValue = useMemo(() => ({
    registerArea, unregisterArea, setActiveArea, getActiveScrollState, scrollActive,
  }), [registerArea, unregisterArea, setActiveArea, getActiveScrollState, scrollActive]);

  return (
    <ScrollCtx.Provider value={contextValue}>
      {children}
    </ScrollCtx.Provider>
  );
}

/** 注册一个可滚动区域 */
export function useScrollable(id: string, callbacks: {
  getScrollState: () => { scrollTop: number; scrollHeight: number; viewportHeight: number };
  scrollBy: (delta: number) => void;
  scrollTo: (position: "top" | "bottom") => void;
}): void {
  const ctx = useContext(ScrollCtx);
  if (!ctx) throw new Error("useScrollable 必须在 ScrollProvider 内使用");

  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    const area: ScrollableArea = {
      id,
      getScrollState: () => cbRef.current.getScrollState(),
      scrollBy: (delta) => cbRef.current.scrollBy(delta),
      scrollTo: (pos) => cbRef.current.scrollTo(pos),
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
