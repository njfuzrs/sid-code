/**
 * 上下文压力告知（缺口 A）
 *
 * 对应《Harness-LLM 可见性缺口》缺口 A：模型对"快到 token 上限/即将 compact"完全无感知。
 *
 * 根因：queryLoop 每轮已算出 usagePercent / remaining（loop.ts:142-218），但这个数字
 * 只走 `context_warning` 这个 QueryLoopYield 事件被上层 UI/日志消费，从未进入发给模型的
 * 消息流。模型不知道自己快到上限，不会主动收尾 / 把关键结论落盘 / 精简输出，compact
 * 永远是 harness 背着模型突然执行——长任务里关键中间结论可能在落盘前就被压缩丢弃。
 *
 * 解决思路（对标 claude-code attachments.ts 的每轮 delta attachment 通道）：
 * 在 queryLoop 每轮 reminderParts 段，按使用率阈值注入一条上下文压力 system-reminder，
 * 给模型"落盘窗口"。必须走每轮 reminder 通道（随消息流、抗缓存、抗 compact），
 * 不能放进 system prompt（会被 5 分钟缓存冻结）。
 *
 * 设计原则：纯函数（入使用率，出字符串 | null），便于单测，与 todo-reminder.ts 同构。
 */

/**
 * 上下文压力分级阈值（使用率百分比）。
 *
 * 与 context/auto-compact.ts 的 TOKEN_THRESHOLDS 是互补关系：那里按"剩余绝对 token 数"
 * 触发真正的压缩（autoCompact 剩余 ≤13K），这里按"使用率百分比"提前几个百分点给模型
 * 落盘窗口。用百分比而非绝对值，是为了对不同窗口大小的模型（200K / 1M）都能稳定提前预警。
 */
export const CONTEXT_PRESSURE_THRESHOLDS = {
  /** 使用率 ≥ 此值：温和提醒，开始收敛 */
  warn: 80,
  /** 使用率 ≥ 此值：强提醒，马上要压缩了 */
  urgent: 90,
} as const;

/**
 * 上下文压力档位。undefined 表示未达 warn 阈值（不注入）。
 */
export type ContextPressureLevel = "warn" | "urgent";

/**
 * 同一压力档位持续时的低频重述间隔（轮）。
 *
 * 与 permission-reminder / work-log 的 8 轮取齐：pressure 文案里嵌实时百分比，逐字节去重
 * （decideNagInjection）对它无效，故走 cadence 节流——升档时强注入一次，同档持续则每
 * CONTEXT_PRESSURE_REMINDER_INTERVAL 轮才重述一次，避免长任务卡在 80-90% 时每轮刷成
 * "幻影用户消息"（对话重播/截断幻觉根因，见 reminder-throttle.ts）。
 */
export const CONTEXT_PRESSURE_REMINDER_INTERVAL = 8;

/**
 * 判定当前使用率对应的压力档位（纯函数，便于单测与 cadence 节流）。
 * @returns "urgent" | "warn" | undefined（未达阈值）
 */
export function contextPressureLevel(usagePercent: number): ContextPressureLevel | undefined {
  if (usagePercent >= CONTEXT_PRESSURE_THRESHOLDS.urgent) return "urgent";
  if (usagePercent >= CONTEXT_PRESSURE_THRESHOLDS.warn) return "warn";
  return undefined;
}

/**
 * 构造上下文压力告知 system-reminder。
 *
 * 低于 warn 阈值返回 null（不注入，避免每轮刷屏浪费 token）。
 * warn ≤ 使用率 < urgent：温和提醒；使用率 ≥ urgent：强提醒。
 *
 * @param usagePercent 当前上下文使用率（0-100）
 * @param remainingPercent 剩余百分比（通常 100 - usagePercent）
 * @returns system-reminder 文本，或 null（未达阈值）
 */
export function buildContextPressureReminder(
  usagePercent: number,
  remainingPercent: number,
): string | null {
  if (usagePercent < CONTEXT_PRESSURE_THRESHOLDS.warn) return null;

  const usage = usagePercent.toFixed(0);
  const remaining = Math.max(0, remainingPercent).toFixed(0);

  // 设计哲学（对标 claude-code getCompactionReminderAttachment + messages.ts:4143）：
  // claude-code 的压缩提醒**刻意安抚**——"无需停下或赶工,自动压缩让你能无缝继续"。
  // 因为催模型"赶紧收尾"会导致它在任务没做完时草草 end_turn(尤其弱模型对压力敏感)。
  // 所以这里**不催收尾、不催收敛输出**,只做两件有真实价值的事:
  //   ① 告诉模型压缩会发生且能无缝继续(消除"快没空间了"的恐慌);
  //   ② 提醒把关键结论落盘——这是唯一能对抗"压缩丢细节"的实质动作。
  if (usagePercent >= CONTEXT_PRESSURE_THRESHOLDS.urgent) {
    return `<system-reminder>
上下文使用率已达 ${usage}%(剩余约 ${remaining}%),很快会触发自动压缩。压缩会把较早的对话摘要化以便你无缝继续,**无需停下或赶工**。
唯一需要做的:把尚未落盘的关键结论/决定/进度用 todo_write 记录或写入文件,确保它们在压缩后不丢失。然后照常继续当前任务。
(请勿向用户提及或复述本提醒)
</system-reminder>`;
  }

  return `<system-reminder>
上下文使用率已达 ${usage}%(剩余约 ${remaining}%)。接近上限时会自动压缩、摘要化较早的对话以便你无缝继续,**无需停下或赶工**。
建议把尚未落盘的关键结论/决定/进度用 todo_write 记录或写入文件,使其在压缩后仍可追溯。然后照常推进任务。
(请勿向用户提及或复述本提醒)
</system-reminder>`;
}
