/**
 * 会话统计上下文
 *
 * 提供 token 计数、费用、上下文使用量等会话级统计数据。
 * 各组件通过 useSession() 获取，替代直接从 TUIState 读取。
 */

import React, { createContext, useContext, useMemo } from "react";
import type { Usage } from "../../llm/types.ts";

export interface SessionContextValue {
  /** Token 用量统计 */
  usage: Usage;
  /** 累计费用（美元） */
  costUSD: number;
  /** 费用上限 */
  costLimit: number;
  /** 上下文使用百分比 */
  contextPercent: number;
}

const SessionCtx = createContext<SessionContextValue | undefined>(undefined);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionCtx);
  if (!ctx) {
    throw new Error("useSession 必须在 SessionProvider 内使用");
  }
  return ctx;
}

interface SessionProviderProps {
  children: React.ReactNode;
  value: SessionContextValue;
}

export const SessionProvider: React.FC<SessionProviderProps> = ({ children, value }) => {
  const memoized = useMemo(() => value, [
    value.usage,
    value.costUSD,
    value.costLimit,
    value.contextPercent,
  ]);

  return (
    <SessionCtx.Provider value={memoized}>
      {children}
    </SessionCtx.Provider>
  );
};
