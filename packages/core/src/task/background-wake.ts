/**
 * 后台任务 → 空闲主循环的唤醒原语
 *
 * ## 要解决的事故（20261016-124505-786b1586）
 *
 * 主代理派出两个 `run_in_background` 子代理后以 end_turn 结束本轮（"等它们返回后汇总"），
 * 30s 后子代理完成、`<task-notification>` 入队——但队列唯一的消费点在 queryLoop
 * **每轮开头**，而此刻已经没有下一轮了。TUI 的空闲 drain 又只取 user-input。
 * 结果：通知永远躺在队列里，任务"执行到一半自己停了"，无任何报错。
 *
 * 对标 claude-code：交互端 `useQueueProcessor` 在「无查询进行中」时消费队列里**所有** mode
 * （含 task-notification）；headless `print.ts` 在 drain 完命令后若仍有运行中的后台任务，
 * 就 `do { drain; sleep(100) } while (hasRunningBg || hasQueued)` 等下去。
 * 本模块提供这两种形态共用的事件源，不用轮询。
 */

import { subscribeQueue } from "../query/message-queue-manager.ts";
import { hasPendingNotifications } from "./notification.ts";
import { onTaskChanged, offTaskChanged, getRunningTasks } from "./registry.ts";
import { isPanelTask } from "./types.ts";

/**
 * 队列里是否有待投递的后台任务通知。
 *
 * 从 notification.ts 转出（不复用实现，也不改口径）：消费方（app.ts 的 SDK driver、
 * headless-runner 的等待循环）本来要分别 import task/index、notification、registry
 * 三个入口才凑齐这组判断，收在一处更不容易漂。
 */
export { hasPendingNotifications };

/**
 * 是否有运行中的**后台**任务。口径与 index.ts 的 hasRunningTasks 相同（isPanelTask），
 * 不从 index.ts 导入：index 会重导出本模块，反向导入会形成循环依赖。
 * 前台子代理不算——它属于主循环当前这一轮的同步工具调用，轮结束前必然已结束。
 */
export function hasRunningBackgroundTasks(): boolean {
  return getRunningTasks().some(isPanelTask);
}

/**
 * 订阅「可能需要唤醒」的信号：队列变化 + 任务状态变化。
 *
 * ⚠️ 回调**延迟到微任务**才触发，且这是正确性要求，不是优化：
 * `completeAgentTask` 先 `updateTask`（同步通知监听器）、**再** `enqueueTaskNotification`。
 * 若在 updateTask 的回调里当场判断，会看到「无运行中任务 + 无待投递通知」，
 * 误判为"后台已全部结束"而放弃等待——恰好错过那条马上就要入队的通知。
 * 推迟一个微任务后，同一同步段里的入队已完成。
 *
 * @returns 取消订阅函数
 */
export function subscribeBackgroundActivity(listener: () => void): () => void {
  let scheduled = false;
  const fire = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      try {
        listener();
      } catch {
        /* 监听器异常不影响任务系统 */
      }
    });
  };
  const unsubscribeQueue = subscribeQueue(fire);
  onTaskChanged(fire);
  return () => {
    unsubscribeQueue();
    offTaskChanged(fire);
  };
}

export type BackgroundWaitOutcome = "notification" | "idle" | "aborted";

/**
 * 等待后台任务产生可投递的通知。
 *
 * - `notification`：队列里有待投递的 task-notification，调用方应续跑一轮；
 * - `idle`：没有待投递通知，也没有运行中的后台任务——再等也不会有了；
 * - `aborted`：signal 已中止（会话超时 / 用户中断）。
 *
 * 立即可判定时同步返回结果（不挂订阅），否则挂订阅等下一次状态变化。
 */
export function waitForBackgroundNotification(
  signal?: AbortSignal | null,
): Promise<BackgroundWaitOutcome> {
  const evaluate = (): BackgroundWaitOutcome | null => {
    if (signal?.aborted) return "aborted";
    if (hasPendingNotifications()) return "notification";
    if (!hasRunningBackgroundTasks()) return "idle";
    return null;
  };
  const immediate = evaluate();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: BackgroundWaitOutcome) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish("aborted");
    const unsubscribe = subscribeBackgroundActivity(() => {
      const outcome = evaluate();
      if (outcome) finish(outcome);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
