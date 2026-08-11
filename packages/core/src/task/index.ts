/**
 * Task 模块统一导出
 */

export {
  type TaskType,
  type TaskStatus,
  type TaskState,
  type LocalShellTaskState,
  type LocalAgentTaskState,
  type LocalWorkflowTaskState,
  type AgentProgress,
  type AgentTaskResult,
  type ToolActivity,
  isTerminalStatus,
  isPanelTask,
  isPanelVisible,
  isShellTask,
  isAgentTask,
  isWorkflowTask,
  generateTaskId,
} from "./types.ts";

export {
  registerTask,
  updateTask,
  getTask,
  getRunningTasks,
  getAllTasks,
  getPanelVisibleTasks,
  hasPendingEviction,
  evictTerminalTasks,
  dismissTask,
  dismissTerminalTasks,
  hasDismissableTasks,
  graceDeadlineFor,
  EVICT_GRACE_MS,
  KILLED_DISPLAY_MS,
  clearAllTasks,
  clearInactiveTasks,
  generateTaskStatusAttachment,
  onTaskChanged,
  offTaskChanged,
} from "./registry.ts";

export {
  DiskTaskOutput,
  initTaskOutput,
  appendTaskOutput,
  flushTaskOutput,
  getTaskOutputDelta,
  getTaskOutputTail,
  evictTaskOutput,
} from "./disk-output.ts";

export {
  type TaskNotification,
  type NotificationPriority,
  type StructuredNotification,
  type DequeuedNotification,
  formatNotification,
  enqueueTaskNotification,
  enqueuePendingNotification,
  dequeuePendingNotifications,
  hasPendingNotifications,
} from "./notification.ts";

export {
  spawnShellTask,
  adoptRunningProcessAsTask,
  killShellTask,
} from "./shell-task.ts";

export {
  createAgentTask,
  updateAgentProgress,
  appendAgentOutput,
  completeAgentTask,
  failAgentTask,
  killAgentTask,
  getAgentTaskSignal,
} from "./agent-task.ts";

export {
  createWorkflowTask,
  updateWorkflowProgress,
  appendWorkflowOutput,
  completeWorkflowTask,
  failWorkflowTask,
  killWorkflowTask,
  getWorkflowTaskSignal,
} from "./workflow-task.ts";

import { getRunningTasks } from "./registry.ts";
import { isPanelTask, isShellTask, isAgentTask, isWorkflowTask } from "./types.ts";
import { killShellTask } from "./shell-task.ts";
import { killAgentTask } from "./agent-task.ts";
import { killWorkflowTask } from "./workflow-task.ts";

/**
 * 终止所有正在运行的后台任务（Shell / Agent / Workflow），返回被终止的任务数。
 * 供 Ctrl+F「终止全部后台代理」双击确认使用。按各任务类型分派到对应 kill 函数
 * （幂等：已终态任务被 getRunningTasks 过滤掉，不会重复 kill）。
 *
 * 经 isPanelTask 单一闸门（见 types.ts）：只杀**后台**任务。前台子代理属于主循环当前这一轮
 * 的同步工具调用，中断它的语义出口是 ESC（取消整轮），不是「终止全部后台任务」——
 * Ctrl+F 顺手杀掉用户正在等的前台子代理会是意外破坏。
 */
export function killAllRunningTasks(): number {
  const running = getRunningTasks().filter(isPanelTask);
  for (const task of running) {
    if (isShellTask(task)) killShellTask(task.id);
    else if (isAgentTask(task)) killAgentTask(task.id);
    else if (isWorkflowTask(task)) killWorkflowTask(task.id);
  }
  return running.length;
}

/** 当前是否有正在运行的后台任务（供 Ctrl+F 判断是否 no-op）。
 *  与 killAllRunningTasks 同一口径（isPanelTask），否则会出现"提示有任务可终止、
 *  按下去却杀 0 个"的不一致。 */
export function hasRunningTasks(): boolean {
  return getRunningTasks().filter(isPanelTask).length > 0;
}
