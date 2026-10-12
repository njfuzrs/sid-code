/**
 * 重试退避窗口观测（2026-10-12）
 *
 * ## 解决什么
 *
 * 主循环看门狗判的是「单次请求卡死」，而 fallback 漏斗里的重试退避是**我们主动决定的等待**。
 * 此前看门狗把退避也计入「无进展」，于是主循环只好把看门狗阈值（315s）当 deadline 交给漏斗，
 * 让漏斗在被杀前自己收手 —— 结果重试次数实际由看门狗阈值决定（指数退避下 315s 内最多 5–6 次），
 * `maxTimeoutRetries=10` 形同虚设，次数上限与时间上限两套规则互相打架。
 *
 * 现在拆开、各管各的：
 * - **重试几次**：只由次数上限管（fallback 的 `maxRetries`）。
 * - **单次请求卡死**：看门狗只计单次请求 —— 退避中不判，退避结束后从零起算。
 * - **用户不想等**：ESC，退避可被 abort 打断。
 *
 * ## 为什么是旁路观测而不是全局计数器
 *
 * 信号走流本身（`retry_backoff` 事件），与产生它的那次调用天然绑定；
 * 不像 `human-input-gate` 那样是进程级状态 —— 并行子代理各自退避时，
 * 进程级计数器会让 A 的退避暂停 B 的看门狗。
 */

import type { StreamEvent } from "../llm/types.ts";

export interface RetryBackoffWindow {
  /** 当前是否处于退避等待中 */
  readonly active: boolean;
  /** 最近一次退避结束的时刻（epoch ms）；从未退避为 undefined */
  readonly lastEndedAt: number | undefined;
  /** 已结束的退避段累计时长（毫秒） */
  readonly totalMs: number;
}

/**
 * 包裹一条流：逐事件原样透传，同时把 `retry_backoff` 记进返回的窗口状态。
 *
 * `now` 可注入，便于单测。
 */
export function trackRetryBackoff(
  stream: AsyncIterable<StreamEvent>,
  now: () => number = Date.now,
): { stream: AsyncIterable<StreamEvent>; window: RetryBackoffWindow } {
  const state = {
    active: false,
    lastEndedAt: undefined as number | undefined,
    totalMs: 0,
    startedAt: 0,
  };

  const window: RetryBackoffWindow = {
    get active() {
      return state.active;
    },
    get lastEndedAt() {
      return state.lastEndedAt;
    },
    get totalMs() {
      return state.totalMs;
    },
  };

  async function* wrapped(): AsyncGenerator<StreamEvent> {
    for await (const ev of stream) {
      if (ev.type === "retry_backoff") {
        if (ev.phase === "start") {
          state.active = true;
          state.startedAt = now();
        } else if (state.active) {
          const t = now();
          state.active = false;
          state.totalMs += t - state.startedAt;
          state.lastEndedAt = t;
        }
      }
      yield ev;
    }
  }

  return { stream: wrapped(), window };
}
