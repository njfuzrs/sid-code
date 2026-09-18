/**
 * 自动更新 — 通知读写
 *
 * pendingNotice 写入 state.json，下次启动时消费（读取后删除）
 * 同一条通知只展示一次
 */

import { readUpdateState, patchUpdateState } from "./state.ts";

/**
 * 通知类型
 */
export type NoticeType = "updated" | "available" | "failed";

/**
 * 通知内容
 */
export interface PendingNotice {
  type: NoticeType;
  fromVersion?: string;
  toVersion?: string;
  createdAt: string;
}

/**
 * 写入 pending notice
 */
export function writePendingNotice(notice: PendingNotice): void {
  patchUpdateState({ pendingNotice: notice });
}

/**
 * 消费 pending notice（读取后删除，同一条通知只展示一次）
 * @returns PendingNotice 如果存在，null 如果不存在
 */
export function consumePendingNotice(): PendingNotice | null {
  const state = readUpdateState();
  if (!state.pendingNotice) return null;

  const notice = state.pendingNotice;
  // 原子清空
  patchUpdateState({ pendingNotice: undefined });
  return notice;
}

/**
 * 格式化通知文本（用于 TUI transient message）
 */
export function formatNoticeText(notice: PendingNotice): string {
  switch (notice.type) {
    case "updated":
      return `sid-code 已自动更新到 v${notice.toVersion}（原 v${notice.fromVersion}）。/changelog 查看变更`;
    case "available":
      return `新版本 v${notice.toVersion} 可用，运行 sid-code update 更新`;
    case "failed":
      return `自动更新失败（${notice.toVersion || "未知原因"}），当前保持 v${notice.fromVersion}。日志: ~/.sid-code/updates/last-update.log`;
  }
}
