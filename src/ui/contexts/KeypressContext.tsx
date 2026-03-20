/**
 * 键盘事件优先级系统
 *
 * 单一 useInput() 入口，按优先级从高到低分发事件。
 * 返回 true 的 handler 消费事件，后续 handler 不再收到。
 */

import React, { createContext, useContext, useCallback, useRef, useEffect, useMemo } from "react";
import { useInput } from "ink";
import type { Key as InkKey } from "ink";

/** 优先级枚举 */
export enum KeypressPriority {
  Low = -100,
  Normal = 0,
  High = 100,
  Critical = 200,
}

/** Handler 签名：返回 true 表示消费事件 */
export type KeypressHandler = (input: string, key: InkKey) => boolean;

interface Registration {
  id: number;
  priority: KeypressPriority;
  handler: KeypressHandler;
}

interface KeypressContextValue {
  register: (priority: KeypressPriority, handler: KeypressHandler) => number;
  unregister: (id: number) => void;
}

const KeypressCtx = createContext<KeypressContextValue | null>(null);

/** 二分查找插入位置（按 priority 降序） */
function findInsertIndex(arr: Registration[], priority: KeypressPriority): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].priority >= priority) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function KeypressProvider({ children }: { children: React.ReactNode }) {
  const registrationsRef = useRef<Registration[]>([]);
  // 局部 ID 计数器，避免跨实例泄漏
  const nextIdRef = useRef(0);

  const register = useCallback((priority: KeypressPriority, handler: KeypressHandler): number => {
    const id = nextIdRef.current++;
    const reg = { id, priority, handler };
    // 二分插入，保持按 priority 降序排列
    const idx = findInsertIndex(registrationsRef.current, priority);
    registrationsRef.current.splice(idx, 0, reg);
    return id;
  }, []);

  const unregister = useCallback((id: number) => {
    const arr = registrationsRef.current;
    const idx = arr.findIndex(r => r.id === id);
    if (idx !== -1) arr.splice(idx, 1);
  }, []);

  // 单一 useInput 入口
  useInput((input, key) => {
    for (const reg of registrationsRef.current) {
      try {
        if (reg.handler(input, key)) {
          return; // 事件被消费
        }
      } catch (err) {
        // 防止单个 handler 异常导致整个 TUI 崩溃
        if (process.env.DEBUG) {
          console.error(`[KeypressProvider] handler(id=${reg.id}) 异常:`, err);
        }
      }
    }
  });

  // useMemo 包裹 context value，避免不必要的 consumer 重渲染
  const contextValue = useMemo(() => ({ register, unregister }), [register, unregister]);

  return (
    <KeypressCtx.Provider value={contextValue}>
      {children}
    </KeypressCtx.Provider>
  );
}

/**
 * 注册键盘事件处理器
 * handler 返回 true 消费事件，false 传递给下一个
 */
export function useKeypress(priority: KeypressPriority, handler: KeypressHandler): void {
  const ctx = useContext(KeypressCtx);
  if (!ctx) throw new Error("useKeypress 必须在 KeypressProvider 内使用");

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const id = ctx.register(priority, (input, key) => handlerRef.current(input, key));
    return () => ctx.unregister(id);
  }, [ctx, priority]);
}
