/**
 * 任务通知机制
 * 当后台任务完成时，通过 XML 结构化消息通知主对话循环
 */

import type { TaskStatus } from "./types.ts";

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  outputFile: string;
  status: TaskStatus;
  summary: string;
  result?: string;
}

/** 生成 <task-notification> XML */
export function formatNotification(n: TaskNotification): string {
  const parts = [
    "<task-notification>",
    `  <task-id>${n.taskId}</task-id>`,
  ];
  if (n.toolUseId) {
    parts.push(`  <tool-use-id>${n.toolUseId}</tool-use-id>`);
  }
  parts.push(
    `  <output-file>${n.outputFile}</output-file>`,
    `  <status>${n.status}</status>`,
    `  <summary>${n.summary}</summary>`,
  );
  if (n.result) {
    parts.push(`  <result>${n.result}</result>`);
  }
  parts.push("</task-notification>");
  return parts.join("\n");
}

/** 通知优先级 */
export type NotificationPriority = "next" | "later";

interface PendingNotification {
  content: string;
  priority: NotificationPriority;
}

const pendingQueue: PendingNotification[] = [];

/** 入队通知 */
export function enqueuePendingNotification(
  content: string,
  priority: NotificationPriority = "later",
): void {
  pendingQueue.push({ content, priority });
}

/** 出队通知（主循环空闲时调用） */
export function dequeuePendingNotifications(): string[] {
  if (pendingQueue.length === 0) return [];

  pendingQueue.sort((a, b) => {
    if (a.priority === "next" && b.priority === "later") return -1;
    if (a.priority === "later" && b.priority === "next") return 1;
    return 0;
  });

  return pendingQueue.splice(0).map(n => n.content);
}

/** 检查是否有待处理的通知 */
export function hasPendingNotifications(): boolean {
  return pendingQueue.length > 0;
}
