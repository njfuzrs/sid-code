/**
 * 终端能力 React Context
 *
 * 提供终端事件订阅（如 OSC 11 背景色响应）和运行时背景色查询。
 * 在 Provider 层次中位于最外层，先于 KeypressProvider 初始化。
 *
 * 参考 gemini-cli/packages/cli/src/ui/contexts/TerminalContext.tsx
 */

import React, { createContext, useContext, useCallback, useEffect, useRef, useMemo } from "react";
import useStdin from "../../ink/hooks/use-stdin.js";
import useStdout from "../../ink/_vendor/use-stdout.js";
import { TerminalSizeContext } from "../../ink/components/TerminalSizeContext.js";
import { TerminalCapabilityManager } from "../utils/terminalCapabilityManager.ts";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";

export type TerminalEventHandler = (event: string) => void;

/** 终端尺寸信息 */
export interface TerminalDimensions {
  /** 终端宽度（列数） */
  width: number;
  /** 终端高度（行数） */
  height: number;
}

interface TerminalContextValue {
  subscribe: (handler: TerminalEventHandler) => void;
  unsubscribe: (handler: TerminalEventHandler) => void;
  /** 查询终端背景色（异步，100ms 超时） */
  queryTerminalBackground: () => Promise<void>;
  /** 终端尺寸（响应式，窗口 resize 时自动更新） */
  dimensions: TerminalDimensions;
}

const TerminalCtx = createContext<TerminalContextValue | undefined>(undefined);

export function useTerminalContext() {
  const context = useContext(TerminalCtx);
  if (!context) {
    throw new Error("useTerminalContext 必须在 TerminalProvider 内使用");
  }
  return context;
}

/** 便捷 hook：获取终端尺寸 */
export function useTerminalDimensions(): TerminalDimensions {
  return useTerminalContext().dimensions;
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

  // 终端尺寸：直接派生自 ink 的 TerminalSizeContext，**不要**自己挂 resize 监听。
  //
  // 关键坑（Footer 行2 右对齐失效的真根因，两次误修都没碰到这层）：
  // 上面 useStdout() 返回的是 _vendor/use-stdout.ts 的 **Proxy**，它的 columns/rows
  // 读的是 TerminalSizeContext（React 值），不是真实 process.stdout。resize 监听器
  // 闭包捕获的 proxy 属于「effect 运行那次渲染」的 context 值，于是回调里读到的
  // stdout.columns 恒为**上一次**的宽度：ink.handleResize 先跑（更新 terminalColumns
  // → 新 context），我们的监听器随后拿旧 proxy 读到旧值并写进 state。实测
  // 60→120→50 时 dimensions 依次为 60、60、120 —— 永久滞后一次 resize。
  // 后果：MainScreenLayout 用 width={termWidth} 定死根 Box 宽度，行2 flex-end 便按
  // 滞后宽度右对齐（偏左）；而当滞后值 > 真实宽度时整行溢出被裁 —— 正是「只有初始
  // 贴边、拖动后不跟随且被截断」。ink 自身的 yoga 宽度一直是对的，错的是 React 侧。
  //
  // 正解是消掉这条重复且滞后的链路：ink 的 handleResize 已经把新尺寸经
  // TerminalSizeContext 推下来并驱动重渲染，直接读它即单一事实源、零滞后。
  // 用 || 而非 ??：非 TTY / 管道场景 columns 可能是 0，0 宽度会让整个布局塌掉，
  // 必须一路回退到默认值（沿用改动前的 `stdout.columns || DEFAULT_TERM_WIDTH` 语义）。
  const inkSize = useContext(TerminalSizeContext);
  const width = inkSize?.columns || stdout.columns || DEFAULT_TERM_WIDTH;
  const height = inkSize?.rows || stdout.rows || 24;
  // 依赖两个基础类型而非对象字面量，否则每次渲染都是新引用，白费下游 memo。
  const dimensions = useMemo<TerminalDimensions>(
    () => ({ width, height }),
    [width, height],
  );

  const contextValue = useMemo(
    () => ({ subscribe, unsubscribe, queryTerminalBackground, dimensions }),
    [subscribe, unsubscribe, queryTerminalBackground, dimensions],
  );

  return (
    <TerminalCtx.Provider value={contextValue}>
      {children}
    </TerminalCtx.Provider>
  );
}
