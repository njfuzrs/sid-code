/**
 * Worktree Analytics 事件上报（P2-10）
 *
 * 追踪 worktree 使用频率和错误率。轻量实现：结构化日志 + 可选 telemetry 计数。
 * 不依赖 span 上下文（worktree 操作多发生在工具执行外，没有现成 span）。
 *
 * 事件：
 * - worktree_created:  {slug, hookBased, prNumber?, durationMs, usedSparsePaths?}
 * - worktree_kept:     {slug, ageMs}
 * - worktree_removed:  {slug, discardedFiles, discardedCommits, ageMs}
 * - worktree_cleanup:  {removedCount, skippedCount}
 * - worktree_resume:   {slug, success}
 */

import { getLogger } from "../debug/logger.ts";

export type WorktreeEventName =
  | "worktree_created"
  | "worktree_kept"
  | "worktree_removed"
  | "worktree_cleanup"
  | "worktree_resume";

/**
 * 上报一个 worktree analytics 事件。
 * 容错：上报失败绝不影响主流程。
 */
export function logWorktreeEvent(event: WorktreeEventName, data: Record<string, unknown>): void {
  try {
    const log = getLogger();
    log.info("WORKTREE_ANALYTICS", `${event} ${JSON.stringify(data)}`);
  } catch {
    /* 忽略 */
  }
}
