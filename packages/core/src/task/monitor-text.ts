/**
 * monitor 展示文案与格式的唯一来源。
 *
 * 通知文案原来分散在 `monitor-task.ts` 的 `admit` / `drainAll` / 终态函数里，
 * 已经漂移过一次（D18）：
 *
 * 1. 限流合并后的「…另有 N 条」让模型以为还有 N 条**没收到**，实际那些行已经
 *    全部被并进正文（被暂存的行排在最前），「另有」说的是「其中几行是延迟合并的」；
 * 2. 「共 N 条事件」的 N 来自 `eventCount`，它按**通知**累加，不是脚本输出行数，
 *    模型会把它读成「脚本打了 N 行」。
 *
 * 两个单位必须写死在这里并在所有出口复用：
 * - **条** = 投递的通知数（每条都叫醒主循环一次，是「更省」方向的口径）；
 * - **行** = 脚本 stdout 的输出行数（模型据此判断过滤条件是否覆盖了终态）。
 *
 * 时钟格式也在这里（D17）：`monitor` 工具结果与 `bg_task_list` / `bg_task_get` /
 * `task_output` 的 `<deadline>` 必须是同一个本地时钟口径，复制三份就会再漂移一次。
 */

/** 本地时钟 HH:MM:SS：monitor 的「最晚几点结束」按用户本地时区显示，不做 UTC 换算 */
export function formatClockWithSeconds(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

/** 限流合并提示：暂存行已全部并入正文，只是延迟送达（不是「还有 N 条没给你」） */
export function formatDeferredMergeNotice(deferredCount: number): string {
  return `（以上含 ${deferredCount} 行因限流延迟，非实时）`;
}

/** 终态冲刷的截断提示：保尾不保头，完整内容在 `.output` */
export function formatOmittedLinesNotice(omitted: number): string {
  return `…前 ${omitted} 行已省略，完整输出见 .output`;
}

/** 终态投递摘要：通知数与输出行数各自带单位，避免把「条」读成「行」 */
export function formatDeliverySummary(notifyCount: number, outputLines: number): string {
  return `共投递 ${notifyCount} 条通知，输出共 ${outputLines} 行`;
}
