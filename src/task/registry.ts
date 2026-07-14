/**
 * Task 注册表
 * 全局 Task 状态管理，提供注册、更新、查询、驱逐等原子操作
 */

import {
  type TaskState,
  isTerminalStatus,
  isAgentTask,
} from "./types.ts";
import { getTaskOutputTail, evictTaskOutput } from "./disk-output.ts";

/** 全局任务存储 */
const tasks = new Map<string, TaskState>();

/** 任务变更监听器集合（M5: 事件驱动 TUI 刷新） */
type TaskChangeCallback = () => void;
const changeListeners = new Set<TaskChangeCallback>();

/** 注册任务变更监听器 */
export function onTaskChanged(callback: TaskChangeCallback): void {
  changeListeners.add(callback);
}

/** 取消注册任务变更监听器 */
export function offTaskChanged(callback: TaskChangeCallback): void {
  changeListeners.delete(callback);
}

/** 通知所有监听器任务已变更 */
function notifyTaskChanged(): void {
  for (const cb of changeListeners) {
    try { cb(); } catch { /* 监听器异常不应影响任务系统 */ }
  }
}

/** 注册新任务 */
export function registerTask(task: TaskState): void {
  tasks.set(task.id, task);
  notifyTaskChanged();
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
    notifyTaskChanged();
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

/** 驱逐缓冲期（对标 CC PANEL_GRACE_MS = 30_000）。
 *  任务完成后必须等待此时长才能被驱逐，给主循环模型留足通过 task_output 查询结果的窗口。
 *  设为 60s（比 CC 的 30s 更保守），覆盖模型多轮决策 + 网络延迟场景。 */
const EVICT_GRACE_MS = 60_000;

/** 驱逐已完成且已通知且缓冲期已过的任务。
 *  终止态（completed/failed/killed）任务一旦其完成通知已入队（notified=true）
 *  且缓冲期（evictAfter）已过，在面板上即属冗余——通知会经 dequeuePendingNotifications
 *  注入对话，任务条目应清除。三层门控对标 CC：① isTerminalStatus ② notified ③ evictAfter。
 *  删除发生时通知监听器刷新 TUI（否则面板不会重渲、仍显示已完成条目）。
 *
 *  @param force 忽略缓冲期（evictAfter）检查，只要求 ① isTerminalStatus ② notified。
 *    缓冲期的意义是"任务完成后留一个窗口，让主循环模型还能用 task_output 查结果"——
 *    但当主循环已经终止（end_turn 收尾）时不会再有下一轮查询，缓冲期失去意义。此时
 *    必须 force 驱逐，否则"最后完成、缓冲期还没到"的任务会因再无下一轮循环触发驱逐而
 *    永久残留在面板（现象：「后台任务 · N 已完成」不消失）。见 loop.ts 收尾块调用点。 */
export function evictTerminalTasks(force = false): void {
  const now = Date.now();
  let evicted = false;
  for (const [id, task] of tasks) {
    if (
      isTerminalStatus(task.status) &&
      task.notified &&
      (force || (task.evictAfter ?? 0) <= now)  // 缓冲期检查：force 时跳过；未设置视为 0（兼容旧任务立即驱逐）
    ) {
      evictTaskOutput(id);   // 连带清磁盘 .output 文件 + 内存 outputs 条目，避免孤儿泄露
      tasks.delete(id);
      evicted = true;
    }
  }
  if (evicted) notifyTaskChanged();
}

/** 获取驱逐缓冲期常量（供外部使用） */
export { EVICT_GRACE_MS };

/** 清理所有任务（会话结束时调用）。
 *  连带清 outputs 内存条目 + 磁盘 .output 文件，并通知监听器刷新面板——
 *  仅 tasks.clear() 会留下 outputs 孤儿（disk-output 的 Map 与磁盘文件不随之清理）。 */
export function clearAllTasks(): void {
  for (const id of tasks.keys()) {
    evictTaskOutput(id);
  }
  tasks.clear();
  notifyTaskChanged();
}

/** 清理非运行态任务（/clear 时调用）。
 *  /clear 重置的是「当前会话上下文」，不应杀掉用户正在跑的后台 agent；
 *  但已完成/失败/被杀的旧任务条目若不清，会残留在面板上（getConversationClearedPatch
 *  只清 UI 快照 tasks:[]，registry Map 不清 → 下次 notifyTaskChanged 旧条目复活）。
 *  故只驱逐终止态任务（不论是否 notified），保留 running。 */
export function clearInactiveTasks(): void {
  let cleared = false;
  for (const [id, task] of tasks) {
    if (isTerminalStatus(task.status)) {
      evictTaskOutput(id);
      tasks.delete(id);
      cleared = true;
    }
  }
  if (cleared) notifyTaskChanged();
}

/** 生成任务状态附件（注入系统提示词，包含运行中 Agent 的增量输出） */
export async function generateTaskStatusAttachment(): Promise<string | null> {
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

      // 进度摘要（M5 opt-in）
      if (task.progressSummary) {
        lines.push(`    <progress-summary>${task.progressSummary}</progress-summary>`);
      }

      // 增量输出：获取最近输出片段（最多 500 字符）
      try {
        const tail = await getTaskOutputTail(task.id, 500);
        if (tail) {
          const trimmed = tail.slice(-500).replace(/<\/?[^>]+(>|$)/g, ""); // 防 XML 注入
          lines.push(`    <recent-output>${trimmed}</recent-output>`);
        }
      } catch {
        // 输出文件可能还不存在，忽略
      }
    }
    lines.push(`  </task>`);
  }
  lines.push("</task-statuses>");
  return lines.join("\n");
}
