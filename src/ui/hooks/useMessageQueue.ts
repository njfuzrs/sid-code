/**
 * useMessageQueue — 流式响应期间暂存用户输入
 *
 * 当 LLM 正在响应时，用户输入会被暂存到队列中。
 * 响应结束后（StreamingState 变为 Idle），自动按顺序发送队列中的消息。
 *
 * 缺口1 Phase C（h2A 收敛）：底层存储从 React 局部 state 改为统一优先级队列
 * `src/query/message-queue-manager.ts`，与后台任务通知 / mid-turn 抢占共享同一队列内核。
 * - 入队：普通排队走 `next` 级；`enqueueNow` 走 `now` 级（ESC 改向/显式中断，可被 loop mid-turn 抢占）。
 * - 计数：经 useSyncExternalStore 订阅队列快照，只计 user-input 类命令（"已排队 N 条"）。
 * - drain：保持现状语义——仅在 streamingState===Idle 时逐条取 user-input 发送，向后兼容。
 *   task-notification（`later` 级）不在此 drain，仍由 queryLoop 回合边界处理，互不干扰。
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { StreamingState } from "../types.ts";
import {
  enqueueCommand,
  dequeueFirstByKind,
  dequeueLastByKind,
  getQueueSnapshot,
  subscribeQueue,
} from "../../query/message-queue-manager.ts";

export interface UseMessageQueueReturn {
  /** 入队一条普通排队消息（next 级） */
  enqueue: (text: string) => void;
  /** 入队一条抢占消息（now 级，ESC 改向；开启 mid-turn drain 时可被 loop 抢占插入） */
  enqueueNow: (text: string) => void;
  /**
   * P2-G6：把队尾（最近入队）的一条 user-input 弹出返回，供输入框继续编辑。
   * 无排队 user-input 时返回 null。取出即从队列移除。
   */
  popLastForEdit: () => string | null;
  /** 队列中待发送的用户输入数量 */
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
  const isProcessingRef = useRef(false);
  const isProcessingStateRef = useRef(false);

  // 订阅统一队列快照，派生「待发送用户输入」条数（useSyncExternalStore 保证稳定引用/正确重渲）。
  const snapshot = useSyncExternalStore(subscribeQueue, getQueueSnapshot, getQueueSnapshot);
  const queueLength = snapshot.filter((c) => c.kind === "user-input").length;

  const enqueue = useCallback((text: string) => {
    enqueueCommand({ priority: "next", kind: "user-input", payload: text });
  }, []);

  const enqueueNow = useCallback((text: string) => {
    enqueueCommand({ priority: "now", kind: "user-input", payload: text });
  }, []);

  // P2-G6：↑ 弹回编辑——取队尾最近排的一条 user-input 回输入框。
  const popLastForEdit = useCallback((): string | null => {
    const taken = dequeueLastByKind("user-input");
    return taken && typeof taken.payload === "string" ? taken.payload : null;
  }, []);

  // 当 streamingState 变为 Idle 且队列有待发送 user-input 时，逐条按序发送。
  // 逐条 drain（每次只取 1 条）保持与旧实现完全一致的接续语义，避免一次性 flush 改变行为。
  useEffect(() => {
    if (streamingState !== StreamingState.Idle) return;
    if (queueLength === 0) return;
    if (isProcessingRef.current) return;

    const processNext = async () => {
      isProcessingRef.current = true;
      isProcessingStateRef.current = true;

      // 只取队首那条 user-input（保持 FIFO、不触碰 task-notification），发送后其余留待下次 effect。
      // 逐条接续语义与旧实现完全一致：每次 Idle 只发一条，避免一次性 flush 改变行为。
      const first = dequeueFirstByKind("user-input");

      try {
        if (first && typeof first.payload === "string") {
          await onSend(first.payload);
        }
      } catch {
        // 发送失败不重试，丢弃
      }

      isProcessingRef.current = false;
      isProcessingStateRef.current = false;
    };

    processNext();
  }, [streamingState, queueLength, onSend]);

  return {
    enqueue,
    enqueueNow,
    popLastForEdit,
    queueLength,
    isProcessing: isProcessingStateRef.current,
  };
}
