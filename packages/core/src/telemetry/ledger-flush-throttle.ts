/**
 * 账本增量刷新的节流判据（20261020 ce7ea52e 评估 发现 8）。
 *
 * 根因：账本此前只在每次用户提问的 `done` 与退出路径刷新。一次提问跑了 11 小时、
 * 最后被 abort 的会话，`done` 从未到达，进程又一直活着不退出 → 账本停在第 1 问结束时，
 * trace-digest 报 $0.17，而真实花费 $11.2（BilledRequest × 价表复算与 TUI 吻合）。
 *
 * 修法：每次入账（`SessionState.updateUsage` / `addSideCost`）后问一次本判据，
 * 满足「距上次刷新 ≥ 30s」或「成本增量 ≥ $0.1」才写。`upsertUsageLedger` 是全量重写，
 * 不节流就是每次 fetch 一次全量 IO；节流后每会话每分钟最多约 2 次。
 * abort / 退出路径不走节流，用 {@link LedgerFlushThrottle.isDirty} 判断有没有新入账再强刷。
 *
 * 「有没有新入账」看的是 SessionState 的入账版本号，**不是成本**：本地 provider（ollama 等）
 * 成本恒为 0，按成本判脏会让它的账本行永远写不进去（改前 done 是无条件写的）。
 * 成本只用来决定「要不要提前刷」（增量 ≥ $0.1）。
 *
 * 判据写成纯函数 + 小状态类，是为了能在 core 单测：app.ts 的接线只剩「调它、按结果写」。
 */

/** 距上次刷新的最短间隔（毫秒） */
export const LEDGER_FLUSH_MIN_INTERVAL_MS = 30_000;
/** 触发提前刷新的成本增量（美元） */
export const LEDGER_FLUSH_MIN_COST_DELTA_USD = 0.1;

export interface LedgerFlushMark {
  atMs: number;
  costUSD: number;
  /** 刷新时的 SessionState 入账版本号（见 SessionState.getUsageVersion） */
  version: number;
}

/**
 * 是否该刷新账本。
 *
 * - 入账版本没变 → 不刷（时间过去再久，写进去的也是同一行）；
 * - 从未刷新过（`last === null`）且已有入账 → 刷（让第一笔尽快可见）；
 * - 否则成本增量或间隔任一达标即刷。
 */
export function shouldFlushLedger(
  last: LedgerFlushMark | null,
  nowMs: number,
  costUSD: number,
  version: number,
  opts: { minIntervalMs?: number; minCostDeltaUSD?: number } = {},
): boolean {
  const minInterval = opts.minIntervalMs ?? LEDGER_FLUSH_MIN_INTERVAL_MS;
  const minDelta = opts.minCostDeltaUSD ?? LEDGER_FLUSH_MIN_COST_DELTA_USD;
  if (last === null) return version > 0;
  if (version === last.version) return false;
  if (costUSD - last.costUSD >= minDelta) return true;
  return nowMs - last.atMs >= minInterval;
}

/** 记住上次刷新点的小状态机。`/clear` 换会话时调 {@link reset}。 */
export class LedgerFlushThrottle {
  private last: LedgerFlushMark | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** 节流判据：该刷就返回 true（调用方写完后必须 {@link markFlushed}）。 */
  shouldFlush(costUSD: number, version: number): boolean {
    return shouldFlushLedger(this.last, this.now(), costUSD, version);
  }

  /** 自上次刷新后有没有新入账 —— 强刷路径（abort / 退出）用它避免重复全量写。 */
  isDirty(version: number): boolean {
    return this.last === null ? version > 0 : version !== this.last.version;
  }

  markFlushed(costUSD: number, version: number): void {
    this.last = { atMs: this.now(), costUSD, version };
  }

  reset(): void {
    this.last = null;
  }
}
