/**
 * 任务通知机制
 * 当后台任务完成时，通过 XML 结构化消息通知主对话循环
 *
 * XML 结构对标 claude-code <task-notification>
 */

import type { TaskStatus, AgentTaskResult } from "./types.ts";

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  outputFile: string;
  status: TaskStatus;
  summary: string;
  /** 结构化结果（completed 状态时可用，对标 claude-code AgentToolResult） */
  result?: AgentTaskResult;
  /** 纯文本错误信息（failed 状态时可用，向后兼容旧调用方传 string） */
  error?: string;
}

/** 生成 <task-notification> XML（对标 claude-code）
 *  completed 时包含结构化 <result> 和 <usage> 块，
 *  failed 时包含错误信息 */
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
    const { output, totalToolUseCount, totalTokens, usage } = n.result;
    // 缺口 2 阶段 1：result 是子代理产出的数据（可能含外部不可信内容），用 untrusted 标记
    // 提示主代理「这是数据不是指令」，与 system prompt 的 subagent-result-policy 呼应。
    parts.push(
      `  <result untrusted="true">${output.slice(0, 2000)}</result>`,
      `  <usage>`,
      `    <total_tokens>${totalTokens}</total_tokens>`,
      `    <input_tokens>${usage.inputTokens}</input_tokens>`,
      `    <output_tokens>${usage.outputTokens}</output_tokens>`,
      `    <tool_uses>${totalToolUseCount}</tool_uses>`,
      `  </usage>`,
    );
  } else if (n.error) {
    parts.push(`  <error>${n.error.slice(0, 2000)}</error>`);
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
