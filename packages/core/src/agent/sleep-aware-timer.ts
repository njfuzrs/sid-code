// src/agent/sleep-aware-timer.ts
// 扣休眠的一次性定时器：子代理墙钟 / 硬 kill 共用（2026-10-14 事故，卡 B2）。
//
// ── 为什么需要 ─────────────────────────────────────────────────────────
// 会话 20261014-110202-8c0ffb30：三个 explore 子代理实际干活约 3.5 分钟，
// 期间 macOS Idle Sleep 184s，唤醒瞬间裸 `setTimeout(…, 300s)` 补发 → detach。
// 同一时刻 fallback 层流超时（扣休眠）判定「还差 162s」——两套判据结论相反。
// 休眠是非业务时长，不该计入子代理的墙钟预算（与 fallback.ts 流超时同一范式）。
//
// ── 为什么抽成一个函数 ───────────────────────────────────────────────
// 内置 / 自定义两条子代理路径此前各写一份 setTimeout，「两条路径各自手写 → 漏一条」
// 正是 buildBaseLoopConfig 注释里记录的病灶。两处只调本函数。

import {
  createSleepAwareDeadline,
  startSleepObserver,
} from "@sid-code/shared/utils/sleep-detect.ts";

export interface SleepAwareTimer {
  /** 取消定时器并释放休眠观测器引用（幂等）。 */
  cancel(): void;
}

/**
 * 在「扣掉休眠后的有效时长」达到 `ms` 时调用 `onFire`。
 *
 * setTimeout 在休眠后是唤醒即补发：回调里先核 `remainingMs()`，> 0 说明这一枪是
 * 休眠补发的，重排而不开枪。持有 `startSleepObserver()` 引用直到 fire / cancel，
 * 否则账本没人记、remainingMs 恒等于挂钟差值（判据退化回裸 setTimeout）。
 */
export function armSleepAwareTimer(ms: number, onFire: () => void): SleepAwareTimer {
  const release = startSleepObserver();
  const deadline = createSleepAwareDeadline(ms);
  let handle: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const arm = (delay: number): void => {
    handle = setTimeout(() => {
      if (done) return;
      const remaining = deadline.remainingMs();
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      done = true;
      release();
      onFire();
    }, delay);
  };
  arm(ms);

  return {
    cancel(): void {
      if (done) return;
      done = true;
      if (handle !== undefined) clearTimeout(handle);
      release();
    },
  };
}
