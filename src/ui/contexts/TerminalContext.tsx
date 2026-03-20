/**
 * 终端能力 React Context
 *
 * 提供终端事件订阅（如 OSC 11 背景色响应）和运行时背景色查询。
 * 在 Provider 层次中位于最外层，先于 KeypressProvider 初始化。
 *
 * 参考 gemini-cli/packages/cli/src/ui/contexts/TerminalContext.tsx
 */

import React, { createContext, useContext, useCallback, useEffect, useRef, useMemo } from "react";
import { useStdin, useStdout } from "ink";
import { TerminalCapabilityManager } from "../utils/terminalCapabilityManager.ts";

export type TerminalEventHandler = (event: string) => void;

interface TerminalContextValue {
  subscribe: (handler: TerminalEventHandler) => void;
  unsubscribe: (handler: TerminalEventHandler) => void;
  /** 查询终端背景色（异步，100ms 超时） */
  queryTerminalBackground: () => Promise<void>;
}

const TerminalCtx = createContext<TerminalContextValue | undefined>(undefined);

export function useTerminalContext() {
  const context = useContext(TerminalCtx);
  if (!context) {
    throw new Error("useTerminalContext 必须在 TerminalProvider 内使用");
  }
  return context;
}

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const subscribers = useRef<Set<TerminalEventHandler>>(new Set()).current;
  const bufferRef = useRef('');

  const subscribe = useCallback((handler: TerminalEventHandler) => {
    subscribers.add(handler);
  }, [subscribers]);

  const unsubscribe = useCallback((handler: TerminalEventHandler) => {
    subscribers.delete(handler);
  }, [subscribers]);

  const queryTerminalBackground = useCallback(
    async () =>
      new Promise<void>((resolve) => {
        const handler = () => {
          unsubscribe(handler);
          resolve();
        };
        subscribe(handler);
        TerminalCapabilityManager.queryBackgroundColor(stdout);
        // 100ms 超时：终端可能不支持 OSC 11
        setTimeout(() => {
          unsubscribe(handler);
          resolve();
        }, 100);
      }),
    [stdout, subscribe, unsubscribe],
  );

  useEffect(() => {
    const handleData = (data: Buffer | string) => {
      bufferRef.current += typeof data === 'string' ? data : data.toString('utf-8');

      // 检测 OSC 11 响应
      const match = bufferRef.current.match(TerminalCapabilityManager.OSC_11_REGEX);
      if (match) {
        const colorStr = `rgb:${match[1]}/${match[2]}/${match[3]}`;
        for (const handler of subscribers) {
          handler(colorStr);
        }
        // 移除已处理的部分
        if (match.index !== undefined) {
          bufferRef.current = bufferRef.current.slice(match.index + match[0].length);
        }
      } else if (bufferRef.current.length > 4096) {
        // 安全阀：缓冲区过大时截断，保留尾部 1024 字节避免截断不完整序列
        bufferRef.current = bufferRef.current.slice(-1024);
      }
    };

    stdin.on('data', handleData);
    return () => {
      stdin.removeListener('data', handleData);
    };
  }, [stdin, subscribers]);

  const contextValue = useMemo(
    () => ({ subscribe, unsubscribe, queryTerminalBackground }),
    [subscribe, unsubscribe, queryTerminalBackground],
  );

  return (
    <TerminalCtx.Provider value={contextValue}>
      {children}
    </TerminalCtx.Provider>
  );
}
