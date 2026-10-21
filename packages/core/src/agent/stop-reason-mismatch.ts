/**
 * 「stop_reason 与 content 不一致」告警的进程级去重（发现 5，2026-10-21）。
 *
 * 背景：Responses 流式曾把每个带工具的轮都写死成 end_turn，F2 兜底每轮 warn 一次，
 * 一个会话 warn.log 灌进 1340 条同文案。告警被灌满 = 失去区分度：下一个真正的
 * 协议偏差混在里面根本看不出来。根因修掉后这里应该是 0；保留它是为了发现下一个偏差。
 *
 * 口径：按 (provider, model) 首次 warn，之后只计数。计数靠主循环发的
 * `StopReasonMismatch` 事件进 trace-digest，不靠 warn.log 条数。
 */

const counts = new Map<string, number>();

/** 记一次不一致，返回该 (provider, model) 的累计次数；=1 即首次，调用方据此决定是否 warn。 */
export function noteStopReasonMismatch(provider: string, model: string): number {
  const key = `${provider}\u0000${model}`;
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  return n;
}

/** 仅供测试：清空去重表 */
export function resetStopReasonMismatchForTest(): void {
  counts.clear();
}
