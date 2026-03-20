/**
 * 键盘事件优先级系统
 *
 * 单一 useInput() 入口，按优先级从高到低分发事件。
 * 返回 true 的 handler 消费事件，后续 handler 不再收到。
 */

import React, { createContext, useContext, useCallback, useRef, useEffect } from "react";
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

let nextId = 0;

export function KeypressProvider({ children }: { children: React.ReactNode }) {
  const registrationsRef = useRef<Registration[]>([]);

  const register = useCallback((priority: KeypressPriority, handler: KeypressHandler): number => {
    const id = nextId++;
    registrationsRef.current.push({ id, priority, handler });
    // 按优先级降序排列
    registrationsRef.current.sort((a, b) => b.priority - a.priority);
    return id;
  }, []);

  const unregister = useCallback((id: number) => {
    registrationsRef.current = registrationsRef.current.filter(r => r.id !== id);
  }, []);

  // 单一 useInput 入口
  useInput((input, key) => {
    for (const reg of registrationsRef.current) {
      if (reg.handler(input, key)) {
        return; // 事件被消费
      }
    }
  });

  return (
    <KeypressCtx.Provider value={{ register, unregister }}>
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
