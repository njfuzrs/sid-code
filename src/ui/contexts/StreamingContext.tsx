/**
 * 流式状态上下文
 *
 * 提供 StreamingState 枚举，替代 isLoading + isStreaming 布尔值。
 * LoadingIndicator 等组件通过 useStreamingState() 感知当前状态。
 */

import React, { createContext, useContext, useMemo } from "react";
import { StreamingState } from "../types.ts";

export { StreamingState };

interface StreamingContextValue {
  /** 当前流式状态 */
  streamingState: StreamingState;
  /** 流式输出的完整文本 */
  streamingText: string;
  /** 流式思考的完整文本（独立于 streamingText，对标 Claude Code 思考通道） */
  streamingThinking: string;
  /** 当前执行的工具名称 */
  toolName: string | null;
  /** 当前执行的工具输入 */
  toolInput: unknown;
  /** 工具是否正在执行 */
  isToolExecuting: boolean;
  /** 上次工具执行结果 */
  lastToolResult: { toolName: string; isError: boolean; elapsedMs: number } | null;
  /** 状态消息 */
  statusMessage: string;
}

const StreamingCtx = createContext<StreamingContextValue | undefined>(undefined);

export function useStreamingState(): StreamingContextValue {
  const ctx = useContext(StreamingCtx);
  if (!ctx) {
    throw new Error("useStreamingState 必须在 StreamingProvider 内使用");
  }
  return ctx;
}

interface StreamingProviderProps {
  children: React.ReactNode;
  streamingState: StreamingState;
  streamingText: string;
  streamingThinking: string;
  toolName: string | null;
  toolInput: unknown;
  isToolExecuting: boolean;
  lastToolResult: { toolName: string; isError: boolean; elapsedMs: number } | null;
  statusMessage: string;
}

export const StreamingProvider: React.FC<StreamingProviderProps> = ({
  children,
  streamingState,
  streamingText,
  streamingThinking,
  toolName,
  toolInput,
  isToolExecuting,
  lastToolResult,
  statusMessage,
}) => {
  const value = useMemo<StreamingContextValue>(() => ({
    streamingState,
    streamingText,
    streamingThinking,
    toolName,
    toolInput,
    isToolExecuting,
    lastToolResult,
    statusMessage,
  }), [streamingState, streamingText, streamingThinking, toolName, toolInput, isToolExecuting, lastToolResult, statusMessage]);

  return (
    <StreamingCtx.Provider value={value}>
      {children}
    </StreamingCtx.Provider>
  );
};
