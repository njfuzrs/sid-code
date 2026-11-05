/**
 * 会话回滚埋点的单一事实源（观测缺口 G2 / 方案 T2）
 *
 * ## 为什么需要这个模块
 *
 * 「回滚率」是最直接的返工信号，但此前四个回滚入口全都不落事件：
 * Esc+Esc 面板、`/rewind <n>`、`/undo [file]`、`/restore <snapshot>`。
 * 轨迹里能看到的只有 `state/command-usage.json` 的命令计数与文件 diff ——
 * 前者分不出「回滚了对话还是代码、成功还是空转」，后者要人工比对。
 *
 * 收口方式与 `skill/telemetry.ts` / `hook/hook-telemetry.ts` 同款（模块级 sink）：
 *   - 生产点一半在 core 的 RewindManager 里（拿不到 collector），
 *     一半在 CLI 命令层（CommandContext 同样没有 collector）；
 *   - App 在 collector 就绪后调一次 `setRewindTraceSink`，事件落进同一个 events.jsonl；
 *   - sink 未注入（测试、轨迹关闭）时 emit 是空操作，埋点绝不影响回滚本身。
 *
 * ## 为什么在入口层埋而不是 CheckpointManager
 *
 * `RewindManager.rewindTo` 内部也会调 `restoreToSnapshot`，埋在 CheckpointManager 会让
 * 一次面板回滚记两条；而 `/rewind <n>` 只动对话、根本不经过 checkpoint，会整条漏掉。
 * 所以事件必须落在**用户动作的入口**，一次动作恰好一条。
 *
 * ## 隐私（硬性，见方案 §二）
 *
 * events.jsonl 会被 `trace/uploader.ts` 上传，所以这里**不记文件路径原文**：
 * `/undo <file>` 只记 `path_sha12`。路径是用户的项目结构，与 `PostToolUse` 里已有的
 * 路径同级敏感，而回滚统计只需要「撤销的是同一个文件吗」，不需要它是哪个文件。
 */

import { createHash } from "node:crypto";

/** 回滚事件名 —— 生产侧与消费侧（digest / 门禁测试）共用，避免字面量漂移 */
export const REWIND_EVENT_NAME = "Rewind";

/**
 * 回滚入口（闭集）：新增入口必须在这里登记，消费侧按它分桶。
 * - dialog：Esc+Esc 回退面板（RewindManager.rewindTo）
 * - rewind_n：`/rewind <n>` 脚本化快捷路径（只动对话）
 * - undo：`/undo` 撤销最近一次快照
 * - undo_file：`/undo <file>` 撤销单个文件
 * - restore：`/restore <snapshot>`
 */
export type RewindVia = "dialog" | "rewind_n" | "undo" | "undo_file" | "restore";

/**
 * 结果（闭集）：
 * - ok：确实回滚了东西
 * - nothing：没有可回滚的内容（点不存在 / 没有可撤销修改 / 对话锚点失效）
 * - snapshot_miss：回滚点有快照 id，但 `restoreToSnapshot` 返回 null（D5 的复发计数）
 * - error：执行过程中抛错
 */
export type RewindOutcome = "ok" | "nothing" | "snapshot_miss" | "error";

/** 埋点写入通道（由 App 注入，指向 `TraceCollector.recordCustomEvent`） */
export type RewindTraceSink = (data: Record<string, unknown>) => void;

let sink: RewindTraceSink | null = null;

/** 注入/清除埋点通道。传 `null` 表示关闭。 */
export function setRewindTraceSink(s: RewindTraceSink | null): void {
  sink = s;
}

/** 写一条回滚事件。sink 未注入或写入抛错都静默 —— 埋点绝不影响回滚本身。 */
export function emitRewind(
  via: RewindVia,
  outcome: RewindOutcome,
  data: Record<string, unknown> = {},
): void {
  try {
    sink?.({ via, outcome, ...data });
  } catch {
    /* 埋点失败静默 */
  }
}

/** sha256 前 12 位（隐私约束：只记路径摘要，不记路径原文） */
export function sha12(text: string): string {
  try {
    return createHash("sha256").update(text).digest("hex").slice(0, 12);
  } catch {
    // 埋点是尽力而为的旁路：哈希算不出来就退化成固定占位，绝不影响回滚本身
    return "unavailable";
  }
}
