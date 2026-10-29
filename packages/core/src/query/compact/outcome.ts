/**
 * 一次压缩尝试的结局判定（2026-10-29，压缩熔断三态化）。
 *
 * 为什么单独成文件：结局判定是熔断计数的前提，必须是**纯函数**才能逐条变异自证；
 * 放在 loop.ts（6000+ 行）里只能经整条 queryLoop 间接测。
 */

/**
 * 一次压缩尝试的结局。**三态而非 bool**：bool 把「没事可做」和「压不动」压成同一个值，
 * 而这两者对熔断器的意义完全相反 —— 前者不该计数，后者必须计数。
 */
export type CompactionOutcomeKind =
  | "applied" // 真压动了：after < before 或 savedTokens > 0
  | "noop" //    不适用：已达标 / 没有可压缩对象 / 消息太少 / 锁被占（**不计失败**）
  | "failed"; // 尝试了但没效果（**计失败**）

/**
 * 「没事可做」的具体原因，进事件供离线归因。
 *
 * 管线的「三步都无动作」（steps=[] && needsAutoCompact）**刻意不在这里**：hard 档之后一定
 * 还会跑 contextCollapse / autoCompact，它不是最终结局（noopReason 只由最后执行的动作给出）。
 */
export type CompactNoopReason =
  | "already_below_target" //    管线进来时就已达标
  | "no_split_point" //          emergencyTruncate 找不到安全分割点
  | "too_few_messages" //        reactiveCompact / autoCompact：消息数 <= 4
  | "lock_held" //               autoCompact：已有压缩在进行
  | "hook_blocked"; //           autoCompact：pre_compact hook 阻止

/** 压缩入口（与 CompactionAttempt.trigger 同值） */
export type CompactionTrigger =
  | "threshold_blocking"
  | "threshold_emergency"
  | "threshold_hard"
  | "prompt_too_long"
  | "prompt_too_long_stream"
  | "context_overflow"
  | "empty_param_retry"
  | "ctx_window_exceeded";

/**
 * 允许判 noop 的 trigger：只含**主动压缩**类。
 *
 * prompt_too_long* / context_overflow / ctx_window_exceeded 是 API **已拒收**之后的恢复路径，
 * 拒收本身就证明「有事要做」，此时「没东西可压」就是失败。放进来会让 PTL 路径的
 * too_few_messages / no_split_point 从熔断计数里消失。
 */
export const NOOP_ALLOWED_TRIGGERS: ReadonlySet<CompactionTrigger> = new Set([
  "threshold_blocking",
  "threshold_emergency",
  "threshold_hard",
  "empty_param_retry",
]);

export interface CompactionJudgement {
  outcome: CompactionOutcomeKind;
  /** 靠哪条证据判的；非 applied 时为 "none" */
  judgedBy: "message_count" | "saved_tokens" | "none";
  /** 仅 outcome === "noop" 时有值 */
  noopReason?: CompactNoopReason;
}

/**
 * 判定顺序（唯一判定点，调用方禁止自行宣告成败）：
 *   1) after < before                    → applied / message_count
 *   2) savedTokens > 0                   → applied / saved_tokens
 *   3) noopReason 存在且 trigger 允许 noop → noop
 *   4) 其余                              → failed
 *
 * ⚠️ 实测证据必须排在 noopReason 之前：hard 档管线报「没东西可压」、随后 autoCompact
 * 真压动了，反过来排会判成 noop——横幅不画、notifyCompaction 不调。
 * ⚠️ 1、2 不能对调：reactiveCompact 的 tokensBefore 套了锚点、tokensAfter 没套，成功分支
 * 消息数必降，先看消息数才不会把 judgedBy 报成被锚点放大的 saved_tokens。
 */
export function judgeCompaction(info: {
  trigger: CompactionTrigger;
  messageCountBefore: number;
  messageCountAfter: number;
  savedTokens?: number;
  noopReason?: CompactNoopReason;
}): CompactionJudgement {
  if (info.messageCountAfter < info.messageCountBefore) {
    return { outcome: "applied", judgedBy: "message_count" };
  }
  if (info.savedTokens !== undefined && info.savedTokens > 0) {
    return { outcome: "applied", judgedBy: "saved_tokens" };
  }
  if (info.noopReason && NOOP_ALLOWED_TRIGGERS.has(info.trigger)) {
    return { outcome: "noop", judgedBy: "none", noopReason: info.noopReason };
  }
  return { outcome: "failed", judgedBy: "none" };
}
