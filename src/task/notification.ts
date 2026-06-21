/**
 * 任务通知机制
 * 当后台任务完成时，通过 XML 结构化消息通知主对话循环
 *
 * XML 结构对标 claude-code <task-notification>
 */

import type { TaskStatus, AgentTaskResult } from "./types.ts";

/**
 * 通知正文最大字符数。
 *
 * 此前硬编码 2000，子代理结论动辄数 KB（核查报告、逐条结论表），2000 会把
 * 结论截在半句（如 "现在让我汇总…" / 表格只剩一半），主代理拿到的是残缺信息、
 * TUI 上也是断句。提到 16000：子代理 output 是「最终结论文本」而非全量 transcript，
 * 绝大多数结论可完整落入；真正超长时仍截断，但给出明确提示并指向 output-file
 * （完整内容已由 disk-output 落盘，不丢失）。
 */
export const NOTIFICATION_OUTPUT_MAX_CHARS = 16_000;

/** 错误信息最大字符数（错误正文通常较短，给到 4000 足够带上栈/上下文）。 */
export const NOTIFICATION_ERROR_MAX_CHARS = 4_000;

/**
 * 截断长文本：超过 max 时保留前 max 字符并追加一行提示，指向完整内容所在文件。
 * 未超长时原样返回。用码点安全切割（Array.from），避免把多字节字符切坏。
 */
function truncateForNotification(
  text: string,
  max: number,
  outputFile?: string,
): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  const head = codePoints.slice(0, max).join("");
  const omitted = codePoints.length - max;
  const hint = outputFile
    ? `\n\n[输出过长，已截断 ${omitted} 字符。完整内容见 ${outputFile}]`
    : `\n\n[输出过长，已截断 ${omitted} 字符]`;
  return head + hint;
}

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
      `  <result untrusted="true">${truncateForNotification(output, NOTIFICATION_OUTPUT_MAX_CHARS, n.outputFile)}</result>`,
      `  <usage>`,
      `    <total_tokens>${totalTokens}</total_tokens>`,
      `    <input_tokens>${usage.inputTokens}</input_tokens>`,
      `    <output_tokens>${usage.outputTokens}</output_tokens>`,
      `    <tool_uses>${totalToolUseCount}</tool_uses>`,
      `  </usage>`,
    );
  } else if (n.error) {
    parts.push(`  <error>${truncateForNotification(n.error, NOTIFICATION_ERROR_MAX_CHARS, n.outputFile)}</error>`);
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
