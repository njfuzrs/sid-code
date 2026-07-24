/**
 * Git 归因（P3-1）— 可配置的 commit / PR 尾注，单一事实源
 *
 * 对标 CC utils/commitAttribution.ts + attribution.ts：commit 尾注与 PR 尾注分别可配、可关。
 *
 * 三条消费路径共用本模块，避免归因文本三处漂移：
 *   1. /commit、/commit-push-pr skill 的 prompt 动态拼入（覆盖所有 commit 路径）。
 *   2. worktree 的 prepare-commit-msg hook（非 skill 裸 commit 的兜底）。
 *   3. PR 描述尾注（/commit-push-pr、/pr-workflow）。
 *
 * enabled=false 时所有路径都不加归因（对标 CC shouldIncludeGitInstructions）。
 */

import type { GitConfig } from "../config/config.ts";

/** commit 归因默认文本 */
export const DEFAULT_COMMIT_ATTRIBUTION = "Co-Authored-By: sid-code <noreply@sid-code.dev>";
/** PR 归因默认文本 */
export const DEFAULT_PR_ATTRIBUTION = "🤖 Generated with sid-code";

/**
 * 解析 commit 归因文本；关闭或无内容时返回空串。
 * @param git 配置的 git 段（可为 undefined，按默认启用处理）
 */
export function resolveCommitAttribution(git?: GitConfig): string {
  const cfg = git?.commitAttribution;
  // 默认启用（enabled 未设视为 true，保持既有行为）
  if (cfg?.enabled === false) return "";
  const text = cfg?.text?.trim();
  return text && text.length > 0 ? text : DEFAULT_COMMIT_ATTRIBUTION;
}

/**
 * 解析 PR 归因文本；关闭或无内容时返回空串。
 */
export function resolvePrAttribution(git?: GitConfig): string {
  const cfg = git?.prAttribution;
  if (cfg?.enabled === false) return "";
  const text = cfg?.text?.trim();
  return text && text.length > 0 ? text : DEFAULT_PR_ATTRIBUTION;
}

/**
 * 生成注入 skill prompt 的 commit 归因指令段；关闭时返回空串（prompt 里不出现归因相关文字）。
 */
export function commitAttributionInstruction(git?: GitConfig): string {
  const text = resolveCommitAttribution(git);
  if (!text) return "";
  return `在 commit message 末尾追加一行归因（与正文之间空一行）：\n${text}`;
}

/**
 * 生成注入 skill prompt 的 PR 归因指令段；关闭时返回空串。
 */
export function prAttributionInstruction(git?: GitConfig): string {
  const text = resolvePrAttribution(git);
  if (!text) return "";
  return `在 PR 描述末尾追加一行归因：\n${text}`;
}
