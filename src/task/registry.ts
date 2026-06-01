/**
 * Task 注册表
 * 全局 Task 状态管理，提供注册、更新、查询、驱逐等原子操作
 */

import {
  type TaskState,
  isTerminalStatus,
  isAgentTask,
} from "./types.ts";

/** 全局任务存储 */
const tasks = new Map<string, TaskState>();

/** 注册新任务 */
export function registerTask(task: TaskState): void {
  tasks.set(task.id, task);
}

/** 原子性更新任务状态 */
export function updateTask<T extends TaskState>(
  taskId: string,
  updater: (task: T) => T,
): void {
  const task = tasks.get(taskId) as T | undefined;
  if (!task) return;
  const updated = updater(task);
  if (updated !== task) {
    tasks.set(taskId, updated);
  }
}

/** 查询任务 */
export function getTask(taskId: string): TaskState | undefined {
  return tasks.get(taskId);
}

/** 获取所有运行中的任务 */
export function getRunningTasks(): TaskState[] {
  return [...tasks.values()].filter(t => t.status === "running");
}

/** 获取所有任务 */
export function getAllTasks(): TaskState[] {
  return [...tasks.values()];
}

/** 驱逐已完成且已通知的任务 */
export function evictTerminalTasks(): void {
  for (const [id, task] of tasks) {
    if (isTerminalStatus(task.status) && task.notified) {
      tasks.delete(id);
    }
  }
}

/** 清理所有任务（会话结束时调用） */
export function clearAllTasks(): void {
  tasks.clear();
}

/** 生成任务状态附件（注入系统提示词） */
export function generateTaskStatusAttachment(): string | null {
  const running = getRunningTasks();
  if (running.length === 0) return null;

  const lines = ["<task-statuses>"];
  for (const task of running) {
    lines.push(`  <task id="${task.id}" type="${task.type}" status="${task.status}">`);
    lines.push(`    <description>${task.description}</description>`);
    if (isAgentTask(task) && task.progress) {
      const p = task.progress;
      lines.push(`    <progress tools="${p.toolUseCount}" tokens="${p.tokenCount}">`);
      if (p.lastActivity) {
        lines.push(`      <last-activity>${p.lastActivity.toolName}: ${p.lastActivity.activityDescription || ""}</last-activity>`);
      }
      lines.push(`    </progress>`);
    }
    lines.push(`  </task>`);
  }
  lines.push("</task-statuses>");
  return lines.join("\n");
}
