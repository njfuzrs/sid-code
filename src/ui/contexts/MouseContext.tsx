/**
 * 鼠标事件 React Context
 *
 * 从 stdin 原始数据中解析鼠标事件（SGR + X11 协议），
 * 提供 subscribe/unsubscribe API 和 useMouse hook。
 * 支持双击检测（400ms 阈值 + 2px 容差）。
 *
 * 参考 gemini-cli/packages/cli/src/ui/contexts/MouseContext.tsx
 */

import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef } from "react";
import useStdin from "../../ink/hooks/use-stdin.js";
import { ESC } from "../utils/input.ts";
import {
  parseMouseEvent,
  isIncompleteMouseSequence,
  DOUBLE_CLICK_THRESHOLD_MS,
  DOUBLE_CLICK_DISTANCE_TOLERANCE,
  type MouseEvent,
  type MouseEventName,
  type MouseHandler,
} from "../utils/mouse.ts";

export type { MouseEvent, MouseEventName, MouseHandler };

const MAX_MOUSE_BUFFER_SIZE = 4096;

/** 启用鼠标按钮事件 + 拖拽 + 滚轮（?1002h）+ SGR 编码（?1006h） */
const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1006h";
/** 禁用鼠标事件 */
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l";

/** 导出函数：命令式启用鼠标事件（供 Copy Mode 切换使用） */
export function enableMouseEvents() {
  process.stdout.write(ENABLE_MOUSE);
}

/** 导出函数：命令式禁用鼠标事件（供 Copy Mode 切换使用） */
export function disableMouseEvents() {
  process.stdout.write(DISABLE_MOUSE);
}

interface MouseContextValue {
  subscribe: (handler: MouseHandler) => void;
  unsubscribe: (handler: MouseHandler) => void;
}

const MouseCtx = createContext<MouseContextValue | undefined>(undefined);

export function useMouseContext() {
  const context = useContext(MouseCtx);
  if (!context) {
    throw new Error("useMouseContext 必须在 MouseProvider 内使用");
  }
  return context;
}

/** 便捷 hook：注册鼠标事件处理器 */
export function useMouse(handler: MouseHandler, { isActive = true } = {}) {
  const { subscribe, unsubscribe } = useMouseContext();

  useEffect(() => {
    if (!isActive) return;
    subscribe(handler);
    return () => unsubscribe(handler);
  }, [isActive, handler, subscribe, unsubscribe]);
}

export function MouseProvider({
  children,
  mouseEventsEnabled = true,
  onSelectionWarning,
}: {
  children: React.ReactNode;
  mouseEventsEnabled?: boolean;
  /** 当用户尝试拖拽选择文本时触发（提示按 Ctrl+S 进入 Copy Mode） */
  onSelectionWarning?: () => void;
}) {
  const { stdin } = useStdin();
  const subscribers = useRef<Set<MouseHandler>>(new Set()).current;
  const lastClickRef = useRef<{ time: number; col: number; row: number } | null>(null);
  const onSelectionWarningRef = useRef(onSelectionWarning);

  // 保持 ref 同步
  useEffect(() => {
    onSelectionWarningRef.current = onSelectionWarning;
  }, [onSelectionWarning]);

  const subscribe = useCallback((handler: MouseHandler) => {
    subscribers.add(handler);
  }, [subscribers]);

  const unsubscribe = useCallback((handler: MouseHandler) => {
    subscribers.delete(handler);
  }, [subscribers]);

  // 启用/禁用鼠标事件（仅初始化和清理，Copy Mode 切换由外部命令式调用）
  useEffect(() => {
    if (!mouseEventsEnabled) return;
    enableMouseEvents();
    return () => {
      disableMouseEvents();
    };
  }, [mouseEventsEnabled]);

  useEffect(() => {
    if (!mouseEventsEnabled) return;

    let mouseBuffer = '';

    const broadcast = (event: MouseEvent) => {
      let handled = false;
      for (const handler of subscribers) {
        if (handler(event) === true) {
          handled = true;
        }
      }

      // 检测拖拽选择：move 事件 + left button + 未被处理 → 提示用户按 Ctrl+S
      if (
        !handled &&
        event.name === 'move' &&
        event.col >= 0 &&
        event.row >= 0 &&
        event.button === 'left'
      ) {
        // 终端应用只在鼠标按下时接收 move 事件，说明用户在拖拽
        // 但因为我们捕获了鼠标事件，终端无法原生选择文本
        onSelectionWarningRef.current?.();
      }

      // 双击检测
      if (event.name === 'left-press') {
        const now = Date.now();
        const lastClick = lastClickRef.current;
        if (
          lastClick &&
          now - lastClick.time < DOUBLE_CLICK_THRESHOLD_MS &&
          Math.abs(event.col - lastClick.col) <= DOUBLE_CLICK_DISTANCE_TOLERANCE &&
          Math.abs(event.row - lastClick.row) <= DOUBLE_CLICK_DISTANCE_TOLERANCE
        ) {
          const doubleClickEvent: MouseEvent = { ...event, name: 'double-click' };
          for (const handler of subscribers) {
            handler(doubleClickEvent);
          }
          lastClickRef.current = null;
        } else {
          lastClickRef.current = { time: now, col: event.col, row: event.row };
        }
      }
    };

    const handleData = (data: Buffer | string) => {
      mouseBuffer += typeof data === 'string' ? data : data.toString('utf-8');

      // 安全上限
      if (mouseBuffer.length > MAX_MOUSE_BUFFER_SIZE) {
        mouseBuffer = mouseBuffer.slice(-MAX_MOUSE_BUFFER_SIZE);
      }

      while (mouseBuffer.length > 0) {
        const parsed = parseMouseEvent(mouseBuffer);
        if (parsed) {
          broadcast(parsed.event);
          mouseBuffer = mouseBuffer.slice(parsed.length);
          continue;
        }

        if (isIncompleteMouseSequence(mouseBuffer)) {
          break; // 等待更多数据
        }

        // 非有效序列，丢弃到下一个 ESC
        const nextEsc = mouseBuffer.indexOf(ESC, 1);
        if (nextEsc !== -1) {
          mouseBuffer = mouseBuffer.slice(nextEsc);
        } else {
          mouseBuffer = '';
          break;
        }
      }
    };

    stdin.on('data', handleData);
    return () => {
      stdin.removeListener('data', handleData);
    };
  }, [stdin, mouseEventsEnabled, subscribers]);

  const contextValue = useMemo(
    () => ({ subscribe, unsubscribe }),
    [subscribe, unsubscribe],
  );

  return (
    <MouseCtx.Provider value={contextValue}>
      {children}
    </MouseCtx.Provider>
  );
}
