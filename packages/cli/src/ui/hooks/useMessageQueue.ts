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
 * - task-notification：轮中到达的由 queryLoop 回合边界注入；**空闲时到达的由本 hook 触发
 *   `onNotifications` 续跑一轮**（对标 cc `useQueueProcessor`：无查询进行中时消费队列里
 *   所有 mode）。此前本 hook 只认 user-input，主循环 end_turn 之后才完成的后台子代理，
 *   其通知永远没人消费——任务"跑到一半自己停了"且无报错（事故 20261016-124505-786b1586）。
 *   取舍顺序跟队列内核走：队首是谁就先处理谁（user-input 默认 next 优先于通知的 later）。
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
  type QueuedCommand,
} from "@sid-code/core/query/message-queue-manager.ts";

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
  /**
   * 空闲时队首是后台任务通知 → 续跑一轮让模型处理它。不传则通知仍只在回合边界注入（旧行为）。
   * 回调负责实际出队（经 engine.resumeWithNotifications），本 hook 只决定「何时」。
   */
  onNotifications?: () => Promise<void>;
  /**
   * 为 true 时暂不自动续跑通知（对标 cc 的 hasActiveLocalJsxUI）：对话框打开时用户正在
   * 做别的交互，突然开跑一轮会抢走焦点。关闭后依赖变化会重新触发。不影响 user-input 接续。
   */
  notificationsBlocked?: boolean;
}

/** 队首（下一个该处理的）命令的种类。只看本 hook 负责的两类，其余 kind 跳过。 */
export function nextIdleAction(
  snapshot: readonly QueuedCommand[],
): "user-input" | "task-notification" | null {
  for (const c of snapshot) {
    if (c.kind === "user-input" || c.kind === "task-notification") return c.kind;
  }
  return null;
}

export function useMessageQueue({
  streamingState,
  onSend,
  onNotifications,
  notificationsBlocked = false,
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

  // 当 streamingState 变为 Idle 时处理队首：user-input 逐条发送，task-notification 续跑一轮。
  // 逐条 drain（每次只处理 1 项）保持与旧实现完全一致的接续语义，避免一次性 flush 改变行为。
  //
  // 依赖 snapshot 而非 queueLength：通知入队不改变 user-input 计数，只看 queueLength 的话
  // 空闲时到达的通知不会让 effect 重跑——这正是本次要修的断链。
  useEffect(() => {
    if (streamingState !== StreamingState.Idle) return;
    if (isProcessingRef.current) return;
    const action = nextIdleAction(snapshot);
    if (action === null) return;
    if (action === "task-notification" && (!onNotifications || notificationsBlocked)) return;

    const processNext = async () => {
      isProcessingRef.current = true;
      isProcessingStateRef.current = true;

      try {
        if (action === "user-input") {
          // 只取队首那条 user-input，发送后其余留待下次 effect。队列内核已按
          // (优先级, 入队序) 排好序，故"队首"天然就是 now → next → later 中最该先发的那条。
          const first = dequeueFirstByKind("user-input");
          if (first && typeof first.payload === "string") {
            await onSend(first.payload);
          }
        } else {
          await onNotifications!();
        }
      } catch {
        // 发送失败不重试，丢弃（通知续跑失败由回调自己展示错误）
      }

      isProcessingRef.current = false;
      isProcessingStateRef.current = false;
    };

    processNext();
  }, [streamingState, snapshot, onSend, onNotifications, notificationsBlocked]);

  return {
    enqueue,
    enqueueNow,
    popLastForEdit,
    queueLength,
    queuedByPriority,
    isProcessing: isProcessingStateRef.current,
  };
}
