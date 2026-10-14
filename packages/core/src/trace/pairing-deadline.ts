// src/trace/pairing-deadline.ts
// ModelCallUnpaired 配对看门狗的「有效耗时」判据（卡 F1，2026-10-14）。
//
// ── 为什么需要 ─────────────────────────────────────────────────────────
// 看门狗原是裸 setTimeout(300s)：BeforeModel 之后漏斗里的重试退避（我们**主动**的等待，
// 单次最长 120s）与系统休眠都被算进「请求挂住」。事故会话 110202 的 6 次 ModelCallUnpaired、
// 113129 03:54:33 那条，都是这种误报——真 hang 被淹没在退避 / 休眠噪音里。
// 判据与主循环看门狗对齐（query/retry-backoff-window.ts）：退避中不判、退避与休眠不计入。
//
// ── 为什么退避源取 retry 遥测的 delayMs，而不是 retry_backoff 流事件 ───────
// collector 挂在 hook / 遥测通道上，看不到流本身；而 fallback 在**退避开始前**发 `retry`
// 遥测并带上 effectiveDelayMs（与随后 sleep 的时长同源）。拿它累加与流事件口径一致。

import { createSleepAwareDeadline } from "@sid-code/shared/utils/sleep-detect.ts";

/** 进程级退避账本（只记主循环的 retry：子代理不走 BeforeModel 配对）。 */
export class BackoffLedger {
  private totalMs = 0;
  private activeUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** 记录一次退避（retry 遥测到达时调用） */
  record(delayMs: number): void {
    if (!(delayMs > 0)) return;
    const t = this.now();
    // 新退避从「现在」或「上一段退避结束」较晚者起算，避免重叠时重复计入
    const start = Math.max(t, this.activeUntil);
    this.activeUntil = start + delayMs;
    this.totalMs += delayMs;
  }

  /** 截至此刻**已经过去的**退避总时长（进行中的那段只算已过去部分） */
  elapsedTotalMs(): number {
    const t = this.now();
    const pending = Math.max(0, this.activeUntil - t);
    return this.totalMs - pending;
  }

  isActive(): boolean {
    return this.now() < this.activeUntil;
  }
}

export interface PairingDeadline {
  /** 还差多少有效毫秒才该判 unpaired；0 = 该判了。退避进行中恒 > 0。 */
  remainingMs(): number;
  /** 本窗口内被剔除的退避时长 */
  backoffMs(): number;
  /** 本窗口内被剔除的休眠时长 */
  sleepMs(): number;
}

/** effective = 挂钟差值 − 休眠 − 退避；退避进行中不判。 */
export function createPairingDeadline(
  timeoutMs: number,
  backoff: BackoffLedger,
  now: () => number = Date.now,
): PairingDeadline {
  const sleep = createSleepAwareDeadline(timeoutMs);
  const backoffAtArm = backoff.elapsedTotalMs();
  const armedAt = now();
  const backoffMs = (): number => Math.max(0, backoff.elapsedTotalMs() - backoffAtArm);
  return {
    remainingMs(): number {
      if (backoff.isActive())
        return Math.max(1_000, timeoutMs - (now() - armedAt - sleep.sleepMs() - backoffMs()));
      const effective = now() - armedAt - sleep.sleepMs() - backoffMs();
      return Math.max(0, timeoutMs - effective);
    },
    backoffMs,
    sleepMs: () => sleep.sleepMs(),
  };
}
