/**
 * 定时任务触发埋点的单一事实源（观测缺口 G3 / 方案 T3）
 *
 * ## 为什么需要这个模块
 *
 * `/loop` 到点触发后，轨迹里只多一条 `UserPromptSubmit`——**内容与人手敲的无法区分**。
 * 而「到点了但会话一直忙，30 分钟后才真正执行」这种情况（`scheduler.ts` 的
 * `warnOverdueWhileBusy` 就是为它加的）只进 logger，量不出来。
 *
 * 一次「到点触发」在源码里是**两个时刻**，必须分开记，否则两类延迟会混成一个数：
 *   - `ScheduledFire`：调度器决定触发（可能因会话忙而推迟——`lag_ms` 就是这段）；
 *   - `ScheduledInject`：prompt 真正注入主循环（排队等待——`queue_wait_ms` 是这段）。
 *
 * 收口方式与 `hook/hook-telemetry.ts` / `session/rewind-telemetry.ts` 同款（模块级 sink）：
 * Scheduler 在 core 里、拿不到 TraceCollector；App 在 collector 就绪后接一次
 * `setScheduledTraceSink`，两条事件落进同一个 events.jsonl。
 *
 * ## 时序
 *
 * scheduler 在 cli.ts 启动，早于 collector 初始化（app.ts 的 initTraceCollector）。
 * cron 最小粒度 1 分钟、schedule_wakeup 钳制 ≥60s，实际不会在 collector 就绪前触发；
 * 真发生了 sink 未接 → 静默丢，不补（补发会让 lag 语义失真）。
 *
 * ## 隐私（硬性，见方案 §二）
 *
 * events.jsonl 会被上传，**不记 prompt 原文**（`UserPromptSubmit` 已经有了，不重复）。
 * 只记 `prompt_len` 与 `prompt_sha12`，供与紧随其后的 `UserPromptSubmit` 对账。
 */

import { createHash } from "node:crypto";

/** 到点触发事件名（调度器侧） */
export const SCHEDULED_FIRE_EVENT_NAME = "ScheduledFire";

/** 注入事件名（宿主侧，紧邻 UserPromptSubmit） */
export const SCHEDULED_INJECT_EVENT_NAME = "ScheduledInject";

/**
 * 触发结论（闭集）：
 * - fired：真的交给了宿主（`ScheduledFire.fired_at` 之后才会出现 `ScheduledInject`）
 * - skipped_ungranted：durable 任务未授权（不是本机创建的，或创建后被改过）
 * - claim_failed：磁盘认领失败（别的驱动者抢先 / 任务已删 / 写盘异常）
 * - fire_error：`fireTask` 抛错（宿主注入器同步抛）
 */
export type ScheduledFireOutcome = "fired" | "skipped_ungranted" | "claim_failed" | "fire_error";

/** 分发方式：交互宿主注入 / daemon fork headless（后者本方案不追踪后续） */
export type ScheduledDispatch = "inject" | "daemon";

/** 埋点写入通道（由 App 注入，指向 `TraceCollector.recordCustomEvent`） */
export type ScheduledTraceSink = (event: string, data: Record<string, unknown>) => void;

let sink: ScheduledTraceSink | null = null;

/** 注入/清除埋点通道。传 `null` 表示关闭。 */
export function setScheduledTraceSink(s: ScheduledTraceSink | null): void {
  sink = s;
}

/** 写一条定时任务事件。sink 未注入或写入抛错都静默 —— 埋点绝不影响调度。 */
export function emitScheduledTrace(event: string, data: Record<string, unknown>): void {
  try {
    sink?.(event, data);
  } catch {
    /* 埋点失败静默 */
  }
}

/** sha256 前 12 位（prompt 原文不进轨迹，只留摘要供与 UserPromptSubmit 对账） */
export function promptSha12(prompt: string): string {
  try {
    return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
  } catch {
    // 埋点是尽力而为的旁路：哈希算不出来就退化成固定占位
    return "unavailable";
  }
}
