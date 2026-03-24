/**
 * 加载指示器 Hook
 *
 * 管理加载短语循环 + 计时器，参考 gemini-cli useLoadingIndicator.ts
 * 在 StreamingState.Responding 时激活计时器和短语循环。
 */

import { useState, useEffect, useRef } from "react";
import { StreamingState } from "../types.ts";

/** 加载短语列表 */
const LOADING_PHRASES = [
  "思考中...",
  "分析代码...",
  "搜索文件...",
  "生成方案...",
  "整理思路...",
  "编写代码...",
  "检查逻辑...",
  "优化方案...",
];

/** 短语切换间隔（毫秒） */
const PHRASE_INTERVAL = 4000;

export interface UseLoadingIndicatorProps {
  streamingState: StreamingState;
  toolName?: string | null;
}

export interface UseLoadingIndicatorReturn {
  /** 已过秒数 */
  elapsedTime: number;
  /** 当前加载短语 */
  currentLoadingPhrase: string | null;
}

export function useLoadingIndicator({
  streamingState,
  toolName,
}: UseLoadingIndicatorProps): UseLoadingIndicatorReturn {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phraseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStateRef = useRef<StreamingState>(StreamingState.Idle);

  const isResponding = streamingState === StreamingState.Responding;
  const isWaiting = streamingState === StreamingState.WaitingForConfirmation;

  // 计时器：每秒递增
  useEffect(() => {
    if (isResponding) {
      timerRef.current = setInterval(() => {
        setElapsedTime(t => t + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isResponding]);

  // 状态变化时重置计时器
  useEffect(() => {
    if (prevStateRef.current !== streamingState) {
      if (streamingState === StreamingState.Responding) {
        setElapsedTime(0);
        setPhraseIndex(0);
      }
      prevStateRef.current = streamingState;
    }
  }, [streamingState]);

  // 短语循环
  useEffect(() => {
    if (isResponding && !toolName) {
      phraseTimerRef.current = setInterval(() => {
        setPhraseIndex(i => (i + 1) % LOADING_PHRASES.length);
      }, PHRASE_INTERVAL);
    } else {
      if (phraseTimerRef.current) {
        clearInterval(phraseTimerRef.current);
        phraseTimerRef.current = null;
      }
    }
    return () => {
      if (phraseTimerRef.current) {
        clearInterval(phraseTimerRef.current);
        phraseTimerRef.current = null;
      }
    };
  }, [isResponding, toolName]);

  const currentLoadingPhrase = isResponding && !toolName
    ? LOADING_PHRASES[phraseIndex]
    : null;

  return {
    elapsedTime: isWaiting ? elapsedTime : elapsedTime,
    currentLoadingPhrase,
  };
}
