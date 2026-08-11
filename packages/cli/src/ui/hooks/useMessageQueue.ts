/**
 * useMessageQueue — 流式响应期间暂存用户输入
 *
 * 当 LLM 正在响应时，用户输入会被暂存到队列中。
 * 响应结束后（StreamingState 变为 Idle），自动按顺序发送队列中的消息。
 *
 * 缺口1 Phase C（h2A 收敛）：底层存储从 React 局部 state 改为统一优先级队列
 * `src/query/message-queue-manager.ts`，与后台任务通知 / mid-turn 抢占共享同一队列内核。
 * - 入队：`enqueue(text, priority)` — 省略优先级为 `next`（默认排队）；`now` 插队最先发
 *   （开 mid-turn drain 时还可被 loop 中途抢占插入）；`later` 排在所有 next 之后。
 *   键位入口见 defaultBindings 的 `input:submitNow` / `input:submitLater`（Alt+N / Alt+L）。
 * - 计数：经 useSyncExternalStore 订阅队列快照，只计 user-input 类命令（"已排队 N 条"），
 *   并按 now/next/later 分组给 InputArea 做分组提示（P1-G6）。
 * - drain：仅在 streamingState===Idle 时逐条取 user-input 发送。出队顺序由队列内核保证
 *   （now → next → later，同级 FIFO），本 hook 不再自行排序。
 *   task-notification 不在此 drain，仍由 queryLoop 回合边界处理，互不干扰。
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { StreamingState } from "../types.ts";
import {
  enqueueCommand,
  dequeueFirstByKind,
  dequeueLastByKind,
  getQueueSnapshot,
  subscribeQueue,
  type CommandPriority,
} from "../../query/message-queue-manager.ts";

/** P1-G6：按优先级分组的排队条数（供 InputArea 分组提示）。 */
export interface QueuedByPriority {
  now: number;
  next: number;
  later: number;
}

export interface UseMessageQueueReturn {
  /**
   * 入队一条排队消息。priority 省略为 `next`（默认排队）；
   * `now` 插队最先发；`later` 排在所有 next 之后。
   */
  enqueue: (text: string, priority?: CommandPriority) => void;
  /**
   * 入队一条抢占消息（now 级）。等价 `enqueue(text, "now")`——保留独立入口，
   * 便于 ESC 改向这类"语义上就是抢占"的调用点直接表达意图。
   */
  enqueueNow: (text: string) => void;
  /**
   * P2-G6：把队尾（最近入队）的一条 user-input 弹出返回，供输入框继续编辑。
   * 无排队 user-input 时返回 null。取出即从队列移除。
   */
  popLastForEdit: () => string | null;
  /** 队列中待发送的用户输入数量（各优先级合计） */
  queueLength: number;
  /** P1-G6：按优先级分组的待发送用户输入条数 */
  queuedByPriority: QueuedByPriority;
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

  // P1-G6：一次遍历同时得到总数与分组数（避免多次 filter 扫同一快照）。
  // useMemo 让 queuedByPriority 引用在快照不变时稳定，不给下游组件制造无谓重渲。
  const { queueLength, queuedByPriority } = useMemo(() => {
    const counts: QueuedByPriority = { now: 0, next: 0, later: 0 };
    let total = 0;
    for (const c of snapshot) {
      if (c.kind !== "user-input") continue;
      total++;
      counts[c.priority]++;
    }
    return { queueLength: total, queuedByPriority: counts };
  }, [snapshot]);

  const enqueue = useCallback((text: string, priority: CommandPriority = "next") => {
    enqueueCommand({ priority, kind: "user-input", payload: text });
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

      // 只取队首那条 user-input，发送后其余留待下次 effect。队列内核已按
      // (优先级, 入队序) 排好序，故"队首"天然就是 now → next → later 中最该先发的那条。
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
    queuedByPriority,
    isProcessing: isProcessingStateRef.current,
  };
}
