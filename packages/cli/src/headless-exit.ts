/**
 * 无头（`-p`）收尾的退出码判定（P0 #3，2026-10-27）。
 *
 * 抽成纯函数，是因为这条判定以前散在两处 `process.exit(runError || budgetExceeded ? 1 : 0)`，
 * 漏掉了两类「不是正常说完」的收尾，两类都退 0、JSON 里也没有 `error`：
 *
 * 1. `done.incompleteReason` 非空（超时重试耗尽 / 退避期被中断 / 停滞叫停 / 窗口撑爆）。
 *    queryLoop 走的是 `yield done; return`，不抛异常，所以 `runError` 一直是 null。
 * 2. 收到 SIGTERM/SIGINT/SIGHUP。信号处理器与主路径并行收尾，谁先 exit 听谁的；
 *    信号落在退避期时主路径更快，抢先 exit(0)（实测 4/4）。
 *
 * 优先级：信号退出码 > 失败（1） > 成功（0）。信号优先是因为调用方（编排器、CI）
 * 靠 128+signum 区分「我杀的」与「它自己失败的」，被杀的进程不该冒充任何一种自然结局。
 */

import type { DoneIncompleteReason } from "@sid-code/core/query/types.ts";

export interface HeadlessExitInputs {
  /** 已收到信号的退出码（130/143/129/141）；没收到为 null */
  signalExitCode: number | null;
  /** 运行时异常 / fatal_error */
  hasRunError: boolean;
  /** 预算硬停 */
  budgetExceeded: boolean;
  /** 最后一次 done 上的 incompleteReason；正常说完为 undefined */
  incompleteReason?: DoneIncompleteReason;
  /**
   * 会话硬顶（maxSessionDurationMs）触发。它是「配置生效的预期终止」，既有约定是
   * 按成功路径退出（不确定-1②）。硬顶 abort 若恰好落在退避期，loop 会报 aborted ——
   * 那个 aborted 是硬顶本身的回声，不另算失败，否则同一事件在请求在途时退 0、
   * 在退避期退 1，又回到「结论取决于时机」。
   */
  sessionTimedOut?: boolean;
}

/** 本次收尾是否应视为「未完成」（决定 JSON 的 `is_error` 与非 0 退出码） */
export function headlessIncomplete(
  i: Pick<HeadlessExitInputs, "incompleteReason" | "sessionTimedOut">,
): boolean {
  if (!i.incompleteReason) return false;
  if (i.sessionTimedOut && i.incompleteReason === "aborted") return false;
  return true;
}

export function resolveHeadlessExitCode(i: HeadlessExitInputs): number {
  if (i.signalExitCode !== null) return i.signalExitCode;
  if (i.hasRunError || i.budgetExceeded || headlessIncomplete(i)) return 1;
  return 0;
}
