/**
 * 定时任务触发埋点的单一事实源（观测缺口 G3 / 方案 T3）
 *
 * ## 为什么需要这个模块
 *
 * 定时任务到点触发后，轨迹里原先只多一条 `UserPromptSubmit`——**内容与人手敲的无法区分**。
 * （现在 `UserPromptSubmit` 已带 `source` 字段可直接区分，见 engine.ts；`ScheduledInject`
 * 仍然保留，用于量 `queue_wait_ms` 这段排队等待。）
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
 * 唤醒被替换事件名（调度器侧）。
 *
 * `schedule_wakeup` 是单链语义：同一会话同时只保留一个待触发的唤醒，新的替换旧的
 * （见 `Scheduler.replaceSessionTasksByOrigin`）。不记这条的话，「替换」这个动作在轨迹上
 * 完全不可见——只能从「5 次 create、1 次 fire」反推，而那既可能来自替换，也可能来自手动
 * cron_delete。只在真的替换了至少一个任务时发。
 */
export const SCHEDULED_REPLACE_EVENT_NAME = "ScheduledReplace";

/**
 * 唤醒被**确定信号**作废事件名（W3 的 S1 / S2）。
 *
 * 与 `ScheduledReplace`（F2：被更新的唤醒替换）分开：那是「同一件事又排了一次」，
 * 这是「这件事已经不需要再等了」。两者都让唤醒不注入，但原因完全不同——
 * 混成一条之后，「僵尸唤醒还剩多少」无法从轨迹上归因（#642 §6.3）。
 *
 * `signal` 是闭集：`todo_cleared`（S1 清单清零）/ `subject_terminal`（S2 被等对象已终态）。
 */
export const SCHEDULED_INVALIDATED_EVENT_NAME = "ScheduledInvalidated";

/**
 * 注入结论（闭集）：
 * - injected：真的交给了注入器（默认值，老轨迹没有这个字段，读时按它处理）
 * - dropped_superseded：这条唤醒在排队期间已被同一个会话里更新的唤醒替换，丢弃不注入
 * - dropped_invalidated：这条唤醒在排队期间被**确定信号**作废（S1 清单清零 / S2 被等对象已终态），
 *   丢弃不注入。与上一条分开的理由同上：都是「不注入」，但一个是「换成新的了」、
 *   一个是「不需要了」，混在一起之后「僵尸唤醒还剩多少」无法归因。
 *
 * 为什么必须区分：`ScheduledInject` 的语义是「宿主真正调用注入器的次数」，与
 * `ScheduledFire` 对账用。把丢弃的事件也算成注入，对账就永远差几条，而且差得无从归因。
 */
export type ScheduledInjectOutcome = "injected" | "dropped_superseded" | "dropped_invalidated";

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
