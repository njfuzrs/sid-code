/**
 * useMessageQueue — 流式响应期间暂存用户输入
 *
 * 当 LLM 正在响应时，用户输入会被暂存到队列中。
 * 响应结束后（StreamingState 变为 Idle），自动按顺序发送队列中的消息。
 *
 * 参考 gemini-cli 的 message queue 机制。
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { StreamingState } from "../types.ts";

export interface UseMessageQueueReturn {
  /** 入队一条消息 */
  enqueue: (text: string) => void;
  /** 队列中的消息数量 */
  queueLength: number;
  /** 是否正在处理队列 */
  isProcessing: boolean;
}

interface UseMessageQueueOptions {
  /** 当前流式状态 */
  streamingState: StreamingState;
  /** 发送消息的回调 */
  onSend: (text: string) => Promise<void>;
}

export function useMessageQueue({
  streamingState,
  onSend,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [queue, setQueue] = useState<string[]>([]);
  const isProcessingRef = useRef(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const enqueue = useCallback((text: string) => {
    setQueue(prev => [...prev, text]);
  }, []);

  // 当 streamingState 变为 Idle 且队列非空时，自动发送
  useEffect(() => {
    if (streamingState !== StreamingState.Idle) return;
    if (queue.length === 0) return;
    if (isProcessingRef.current) return;

    const processQueue = async () => {
      isProcessingRef.current = true;
      setIsProcessing(true);

      // 取出第一条消息
      const [first, ...rest] = queue;
      setQueue(rest);

      try {
        await onSend(first);
      } catch {
        // 发送失败不重试，丢弃
      }

      isProcessingRef.current = false;
      setIsProcessing(false);
    };

    processQueue();
  }, [streamingState, queue, onSend]);

  return {
    enqueue,
    queueLength: queue.length,
    isProcessing,
  };
}
