/**
 * Todo 回注与完成度校验（P0-2 / P0-3）
 *
 * 对应《长任务遗漏-Harness根因与完成率提升方案》根因 1、2：
 * - 根因 1：todo 写完即沉没，只喂 TUI，从不回注 LLM → 模型靠工作记忆追踪清单，弱模型必然遗漏。
 * - 根因 2：任务被切成碎片、做了一半就 end_turn。
 *
 * 解决思路（对标 claude-code attachments.ts + stopHooks.ts）：
 * - P0-2：每隔 N 轮把**完整 todo 列表**作为 system-reminder 回注，让模型全程可见。
 * - P0-3：end_turn 前硬校验，仍有未完成项则注入提醒并软续命（最多 N 次），把"人肉完成度校验器"内置进 harness。
 */

import type { TodoItem } from "../tool/todo-write.ts";

/**
 * P0-2：todo 回注节流配置。
 * 弱模型（DeepSeek）记忆更短，阈值比 claude-code 的 10 略低，定为 8。
 */
export const TODO_REMINDER_CONFIG = {
  /** 距上次 todo_write ≥ N 轮才回注（避免刚写完就重复提醒） */
  TURNS_SINCE_WRITE: 8,
  /** 两次回注之间至少间隔 N 轮（避免每轮刷屏，浪费 token） */
  TURNS_BETWEEN_REMINDERS: 8,
} as const;

/** P0-3：end_turn 完成度硬校验的最大软续命次数 */
export const MAX_TODO_GATE_RETRIES = 3;

/** 状态文案（与 claude-code messages.ts 的 `[status] content` 渲染对齐） */
function statusLabel(s: string): string {
  return s === "completed"
    ? "completed"
    : s === "in_progress"
      ? "in_progress"
      : "pending";
}

/** 未完成（pending + in_progress）项 */
export function unfinishedTodos(todos: TodoItem[]): TodoItem[] {
  return todos.filter((t) => t.status === "pending" || t.status === "in_progress");
}

/** 未完成项数量 */
export function countUnfinished(todos: TodoItem[]): number {
  return unfinishedTodos(todos).length;
}

/** 把 todo 渲染成带序号 + 状态标签的多行文本 */
function renderTodoLines(todos: TodoItem[]): string {
  return todos
    .map((t, i) => `${i + 1}. [${statusLabel(t.status)}] ${t.content}`)
    .join("\n");
}

/**
 * P0-2：构造 todo 回注 system-reminder。
 * 对标 claude-code attachments.ts:3266 —— 把完整 todo 列表（含状态）作为
 * system-reminder 注入，补偿弱模型不可靠的工作记忆，让"还剩哪些没做"全程可见。
 */
export function buildTodoReminder(todos: TodoItem[]): string {
  const unfinished = countUnfinished(todos);
  return `<system-reminder>
这是你当前的任务清单（请勿向用户提及本提醒）：
${renderTodoLines(todos)}
仍有 ${unfinished} 项未完成。请继续推进，不要遗漏；完成每一项后立即用 todo_write 更新状态。
</system-reminder>`;
}

/**
 * P0-3：构造 end_turn 完成度拦截消息（软续命）。
 * 模型试图收尾但仍有未完成项时注入，驱动它继续做完而非提前 end_turn。
 */
export function buildTodoGateMessage(todos: TodoItem[]): string {
  const pending = unfinishedTodos(todos);
  return `<system-reminder>
检测到你试图结束本轮对话，但任务清单中仍有 ${pending.length} 项未完成：
${renderTodoLines(pending)}
请继续完成这些任务，不要提前收尾。完成每一项后用 todo_write 标记 completed。
如果某项确实无法完成，请明确说明原因（而不是默默跳过或谎报完成）。
</system-reminder>`;
}

/**
 * P0-3：续命次数耗尽时的"放行但如实列出未完成项"消息。
 * 不假装完成——把未尽事项明确呈现给用户。
 */
export function buildTodoGateExhaustedMessage(todos: TodoItem[]): string {
  const pending = unfinishedTodos(todos);
  return `⚠️ 仍有 ${pending.length} 项任务未完成（已达自动续推上限 ${MAX_TODO_GATE_RETRIES} 次）：\n${renderTodoLines(pending)}`;
}
