/**
 * Post-compact 重注入消息的标记前缀（单一事实源）
 *
 * 压缩后主动重注入的几类消息（文件恢复 / Plan 恢复 / 决策点恢复）都带固定前缀，
 * 既用于 TUI/历史层识别为内部消息，也用于 strip.ts 在下一次压缩前剥离它们（防止连环累积）。
 * 集中定义避免前缀字符串在多处硬编码漂移——strip 的剥离判定必须与注入端的前缀逐字节一致。
 */

/** 压缩后恢复的文件内容消息前缀（2.1 Post-compact 文件恢复） */
export const REATTACH_FILE_PREFIX = "[压缩后自动恢复]";

/** 压缩后恢复的 Plan 正文消息前缀（3.3 Plan 文件重注入） */
export const REATTACH_PLAN_PREFIX = "[压缩后恢复 Plan]";

/** 压缩后恢复的决策点摘要消息前缀（4.3 决策点外化） */
export const REATTACH_DECISIONS_PREFIX = "[压缩后恢复 关键决策]";

/** 压缩后恢复的原始任务锚点前缀（防止弱模型压缩后丢失目标） */
export const REATTACH_ORIGINAL_TASK_PREFIX = "[压缩后恢复 原始任务]";

/** 重注入消息的内部来源标记（用于 _meta.origin，TUI 隐藏 + strip 剥离） */
export const REATTACH_ORIGIN = "compact-reattach";
