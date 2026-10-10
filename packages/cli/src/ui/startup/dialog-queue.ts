/**
 * 首屏对话框队列：onboarding > 信任门控 > 外部 @import 审批 > MCP 启动审批。
 *
 * 信任排在 @import 之前——信任是"这个项目能不能执行东西"的前置问题，
 * 比"要不要展开某个 import"更根本（SEC-AUDIT-2026-07-19 P1）。
 *
 * 首屏一次只能挂一个对话框。旧实现关掉信任框 / @import 框就把 activeDialog 置 null，
 * 排在后面的 MCP 启动审批框整个会话都不再出现。所以关闭时要问队列「下一个是谁」。
 */
import type { DialogType } from "@sid-code/core/command-contract/types.ts";

export const STARTUP_DIALOG_QUEUE = [
  "onboarding",
  "trust",
  "claude-md-external-imports",
  "mcp-approval",
] as const satisfies readonly DialogType[];

export type StartupDialog = (typeof STARTUP_DIALOG_QUEUE)[number];

/**
 * 返回 `after` 之后**第一个还有待办**的对话框，没有则 null（`after=null` 从头找）。
 *
 * 只往后走、不回头：Esc「暂不决定」的 MCP 项会留在待审批快照里，往回找会反复弹。
 * `after` 不在队列里（用户主动打开的 /model 等）时返回 null，不把首屏对话框重新拉起来。
 * onboarding 恒不算待办：它由 needsOnboarding 单独驱动，这里只占队首位置。
 */
export function nextStartupDialog(
  after: DialogType | null,
  hasPending: (dialog: StartupDialog) => boolean,
): StartupDialog | null {
  const start =
    after === null ? 0 : (STARTUP_DIALOG_QUEUE as readonly DialogType[]).indexOf(after) + 1;
  if (after !== null && start === 0) return null;
  for (const dialog of STARTUP_DIALOG_QUEUE.slice(start)) {
    if (dialog !== "onboarding" && hasPending(dialog)) return dialog;
  }
  return null;
}
