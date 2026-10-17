// src/agent/turn-hard-timeout.ts
// 子代理单轮硬超时兜底（PR-B S2b，2026-10-17）。
//
// ── 为什么需要 ─────────────────────────────────────────────────────────
// PR-B 删掉了子代理的墙钟与硬 kill（对齐 CC）。在那之前，「`reader.read()` 在半开 TCP
// 上永不 settle、`reader.cancel()` 同样 hang」这种情形是靠 3× 墙钟的硬 kill 间接兜住的；
// 删掉之后若不补这一层，子代理会从「失败」变成「永久挂死」，父代理那次工具调用跟着挂死。
//
// 主循环早有这一层（`query/loop.ts` 的 turn_hard，`Promise.race`）：注释原话是
// 「唯一不依赖 abort/cancel 链路的真兜底」。这里与它**同构**：
//   - 阈值**复用同一个配置项** `maxTurnDurationMs`（90min，env / settings 可覆盖），
//     ⛔ 不得另起子代理专属值——那就是又一层 L6（事故 20261016-224545）；
//   - 扣休眠（同 fallback.ts / loop.ts 的范式），休眠不是业务时长；
//   - 触发后由调用方走**重试**，计入 maxTimeoutRetries，不是判失败。
//
// 它不是总时长限制：只约束「一次模型调用」，且阈值远大于漏斗的内容无进展上限（600s），
// 正常卡顿永远先被漏斗断流 + 重试，走到这里的只有 abort 链路本身失效的情形。

import {
  createSleepAwareDeadline,
  startSleepObserver,
} from "@sid-code/shared/utils/sleep-detect.ts";

/** 单轮硬超时的 abort reason。复用主循环同一个 reason（已登记于 ABORT_REASONS）。 */
export const TURN_HARD_TIMEOUT_REASON = "turn-timeout" as const;

export type TurnRaceOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * 让 `run` 与「扣休眠后满 `timeoutMs`」竞争。
 *
 * - `run` 收到的 signal = 外层 signal ∪ 本轮专属 controller；超时先 abort 本轮 controller
 *   （尽力而为，对已 hang 的 reader 无效也无害），再让 race 立即 settle 交回控制权。
 * - 外层 signal（ESC / task_stop / 父代理取消）不经这里改写，`run` 自行感知。
 * - 周期 tick 而非一次性 setTimeout：休眠后 setTimeout 是唤醒即补发，tick 里每次核对
 *   剩余量才能正确扣休眠（与 loop.ts turn_hard 同一写法）。
 */
export async function raceTurnHardTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs: number; signal: AbortSignal; onFire?: () => void },
): Promise<TurnRaceOutcome<T>> {
  const turnCtrl = new AbortController();
  const merged = AbortSignal.any([opts.signal, turnCtrl.signal]);
  const release = startSleepObserver();
  const deadline = createSleepAwareDeadline(opts.timeoutMs);
  // 检查间隔：5s 级足够及时；阈值很小（单测注入）时用阈值本身，下限 10ms 防忙轮询。
  const checkMs = Math.max(10, Math.min(5_000, opts.timeoutMs));
  let timer: ReturnType<typeof setInterval> | undefined;

  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timer = setInterval(() => {
      if (deadline.remainingMs() > 0) return;
      clearInterval(timer);
      timer = undefined;
      try {
        opts.onFire?.();
      } catch {
        /* 遥测失败不影响兜底 */
      }
      turnCtrl.abort(TURN_HARD_TIMEOUT_REASON);
      resolve({ timedOut: true });
    }, checkMs);
  });

  const runPromise = run(merged).then((value) => ({ timedOut: false as const, value }));
  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearInterval(timer);
    release();
    // 被让出的那次 run 稍后若 reject（abort 生效），不能变成孤儿 rejection。
    runPromise.catch(() => {});
  }
}
