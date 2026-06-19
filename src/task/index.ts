/**
 * Task 模块统一导出
 */

export {
  type TaskType,
  type TaskStatus,
  type TaskState,
  type LocalShellTaskState,
  type LocalAgentTaskState,
  type AgentProgress,
  type AgentTaskResult,
  type ToolActivity,
  isTerminalStatus,
  isShellTask,
  isAgentTask,
  generateTaskId,
} from "./types.ts";

export {
  registerTask,
  updateTask,
  getTask,
  getRunningTasks,
  getAllTasks,
  evictTerminalTasks,
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
  formatNotification,
  enqueuePendingNotification,
  dequeuePendingNotifications,
  hasPendingNotifications,
} from "./notification.ts";

export {
  spawnShellTask,
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
