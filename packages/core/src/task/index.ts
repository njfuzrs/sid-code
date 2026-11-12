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
  type LocalMonitorTaskState,
  type AgentProgress,
  type AgentTaskResult,
  type ToolActivity,
  isTerminalStatus,
  isPanelTask,
  isPanelVisible,
  isShellTask,
  isAgentTask,
  isWorkflowTask,
  isMonitorTask,
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
  markNotificationsDelivered,
  claimResultDelivery,
  isResultDeliveredByToolResult,
  EVICT_GRACE_MS,
  KILLED_DISPLAY_MS,
  UNDELIVERED_SAFETY_VALVE_MS,
  clearAllTasks,
  clearInactiveTasks,
  generateTaskStatusAttachment,
  onTaskChanged,
  offTaskChanged,
} from "./registry.ts";

export {
  TASK_LIFECYCLE_EVENT_NAME,
  type TaskLifecyclePhase,
  type TaskEvictReason,
  type TaskOutputTombstone,
  getCompletedMainTurns,
  markMainTurnCompleted,
  setTaskLifecycleSink,
  getTaskOutputTombstone,
  clearTaskOutputTombstones,
  taskIdFromOutputPath,
  formatTaskOutputTombstone,
} from "./lifecycle.ts";

export {
  DiskTaskOutput,
  initTaskOutput,
  appendTaskOutput,
  flushTaskOutput,
  getTaskOutputDelta,
  getTaskOutputTail,
  getTaskOutputSize,
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
  withdrawTaskNotification,
  NOTIFICATION_OUTPUT_MAX_CHARS,
  truncateForNotification,
} from "./notification.ts";

// 空闲唤醒原语（通知到达时续跑一轮的那套等待/订阅）。集中在这里转出，
// 消费方不必分别 import notification / registry / 队列三个入口。
export {
  subscribeBackgroundActivity,
  waitForBackgroundNotification,
  hasRunningBackgroundTasks,
  type BackgroundWaitOutcome,
} from "./background-wake.ts";

export {
  hasAwaitedBackgroundTasks,
  isAwaitedBackgroundTask,
  beginMainLoopTurn,
  endMainLoopTurn,
  SHELL_QUIESCENT_MS,
} from "./background-await.ts";

// 等待登记表（W1）：显式声明的等待源 + 回报承诺。所有「有东西在等就别催 / 别退」的
// 判断统一走 hasPromisedWait（它是 hasAwaitedBackgroundTasks 的超集）。
export {
  type ReportPromise,
  type WaitSource,
  type WaitSourceKind,
  type WaitReleaseReason,
  type WaitNotice,
  type WaitTraceSink,
  DEADLINE_GRACE_MS,
  WAIT_REGISTERED_EVENT_NAME,
  registerWait,
  releaseWait,
  releaseAllWaits,
  listWaits,
  hasPromisedWait,
  findWaitBySubject,
  isWaitInvalidated,
  invalidateWakeups,
  invalidateWakeupsForDeliveredTask,
  // R3（修法 2）：新起后台等待的回执要写「此刻有无待送达 / 上一条已送达是谁」。
  recordDeliveredTaskNotification,
  getLastDeliveredWaitNotice,
  describeBackgroundWaitFact,
  extractWaitSubjects,
  describeWaitSource,
  drainWaitNotices,
  setWaitTraceSink,
  setWakeupRegistrationEnabled,
  __setMonoClockForTest,
  __clearWaitNoticesForTest,
  __resetWaitRegistryForTest,
} from "./wait-registry.ts";

// 等待准入判定（R2）：同一个对象同时只允许一个有效的显式等待。
// 三个入口（bash / monitor / schedule_wakeup）在启动进程或排唤醒之前都必须过这里。
// 对象签名本身由 R1 的 wait-subjects 提供（见下方），这里只补 R2 的两个判据函数。
export { normalizeWaitCommand, hashScriptBodies } from "./wait-subjects.ts";
export {
  type WaitAdmissionAction,
  type WaitAdmissionInput,
  type WaitAdmissionDecision,
  findActiveWaitsBySubjects,
  decideWaitAdmission,
  formatDuplicateWaitReceipt,
} from "./wait-admission.ts";

export { spawnShellTask, adoptRunningProcessAsTask, killShellTask } from "./shell-task.ts";

// 等待对象签名（R1）：bash / monitor / schedule_wakeup 三个入口共用同一把尺子。
export {
  type WaitSubjectSources,
  MAX_SCRIPT_BODY_BYTES,
  collectWaitSubjects,
  collectWaitCommandFamilies,
  extractNaturalLanguageSubjects,
  extractScriptPaths,
} from "./wait-subjects.ts";

// 等待期外部状态查询守卫（P1）：判「在等 + 只读状态查询 + 结果没变」三条同时成立才拦。
// 与 Q1 的 background-poll-guard 是同一类空转的两个入口，判据不同所以分模块。
export {
  type StatusPollMemo,
  type StatusPollContext,
  type StatusPollCheck,
  STATUS_POLL_PROBE_INTERVAL_MS,
  STATUS_POLL_BLOCK_AFTER_SAME,
  STATUS_POLL_INTERCEPT_KIND,
  checkStatusQueryPoll,
  recordStatusQueryResult,
  markStatusPollIntervened,
  consumeStatusPollIntervened,
  defaultStatusPollContext,
  __resetStatusPollGuardForTest,
} from "./status-poll-guard.ts";

export {
  type StatusQueryKind,
  type StatusQueryMatch,
  matchStatusQuery,
  normalizeStatusOutput,
  summarizeStatusOutput,
} from "./status-query-commands.ts";

export {
  type MonitorGateDecision,
  LineSplitter,
  MonitorRateGate,
  MAX_EVENT_LINE_CHARS,
  EVENT_BATCH_MS,
  BURST_WINDOW_MS,
  BURST_LINE_LIMIT,
  PER_MINUTE_NOTIFY_LIMIT,
  TOTAL_NOTIFY_LIMIT,
  MAX_CONCURRENT_MONITORS,
  MIN_MONITOR_TIMEOUT_MS,
  MAX_MONITOR_TIMEOUT_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
  getMaxConcurrentMonitors,
  getMaxMonitorTimeoutMs,
  getDefaultMonitorTimeoutMs,
  spawnMonitorTask,
  killMonitorTask,
  killAllRunningMonitors,
  countRunningMonitors,
  truncateEventLine,
  setMonitorEventSink,
  MONITOR_EVENT_NAME,
  type MonitorEventSink,
  type MonitorEventTraceData,
} from "./monitor-task.ts";

export {
  MONITOR_META_SUFFIX,
  writeMonitorMeta,
  removeMonitorMeta,
  reapOrphanMonitors,
  classifyMonitorMeta,
  parsePsPgidTable,
  type MonitorProcessMeta,
  type OrphanReapReport,
  type OrphanVerdict,
  type PsRow,
} from "./monitor-orphans.ts";

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
import { isPanelTask, isShellTask, isAgentTask, isWorkflowTask, isMonitorTask } from "./types.ts";
import { killShellTask } from "./shell-task.ts";
import { killAgentTask } from "./agent-task.ts";
import { killWorkflowTask } from "./workflow-task.ts";
import { killMonitorTask } from "./monitor-task.ts";

/**
 * 终止所有正在运行的后台任务（Shell / Agent / Workflow / Monitor），返回被终止的任务数。
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
    // monitor 走自己的 kill：终态文案要说清「是 task_stop 停的」而不是「到期」
    else if (isMonitorTask(task)) killMonitorTask(task.id);
  }
  return running.length;
}

/** 当前是否有正在运行的后台任务（供 Ctrl+F 判断是否 no-op）。
 *  与 killAllRunningTasks 同一口径（isPanelTask），否则会出现"提示有任务可终止、
 *  按下去却杀 0 个"的不一致。 */
export function hasRunningTasks(): boolean {
  return getRunningTasks().filter(isPanelTask).length > 0;
}

/**
 * Ctrl+F 二次确认文案里的类型计数（§5.7.6）。
 *
 * 为什么要点破类型：`终止全部后台任务` 在只有 1 个 shell 时是清楚的，但等待期常见
 * 组合是「1 个 monitor + 1 个 shell」——monitor 被停意味着放弃等 CI，代价和停一个
 * shell 不一样。列出计数让用户在按下第二次之前看见自己将放弃什么。
 *
 * 唤醒**不在**这里：它不是进程（`getRunningTasks` 里没有它），取消唤醒走对话或
 * cron_delete，与 Ctrl+F 无关。
 */
export function describeRunningTasksForKillAll(): string {
  const running = getRunningTasks().filter(isPanelTask);
  let shell = 0;
  let agent = 0;
  let workflow = 0;
  let monitor = 0;
  for (const task of running) {
    if (isMonitorTask(task)) monitor += 1;
    else if (isShellTask(task)) shell += 1;
    else if (isAgentTask(task)) agent += 1;
    else if (isWorkflowTask(task)) workflow += 1;
  }
  const parts: string[] = [];
  if (monitor) parts.push(`${monitor} 个监控`);
  if (shell) parts.push(`${shell} 个 shell`);
  if (agent) parts.push(`${agent} 个 agent`);
  if (workflow) parts.push(`${workflow} 个 workflow`);
  return parts.join("、");
}
