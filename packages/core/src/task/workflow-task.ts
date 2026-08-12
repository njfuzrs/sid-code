/**
 * LocalWorkflowTask — 后台 Workflow 任务执行(Dynamic Workflows M6)
 *
 * 镜像 agent-task.ts:管理后台 workflow 编排脚本的生命周期,完成后经 notification 回注主循环。
 * workflow 与 agent 的区别:workflow 内部会 spawn 多个子 agent,本 task 是它们的"父容器",
 * 进度字段额外记 agentCount / currentPhase。
 */

import {
  generateTaskId,
  type LocalWorkflowTaskState,
  type AgentProgress,
  type AgentTaskResult,
  isTerminalStatus,
} from "./types.ts";
import { registerTask, updateTask, getTask, graceDeadlineFor } from "./registry.ts";
import { initTaskOutput, appendTaskOutput, flushTaskOutput } from "./disk-output.ts";
import { enqueueTaskNotification } from "./notification.ts";

/** 活跃 workflow 的 AbortController(用于 kill) */
const activeWorkflowControllers = new Map<string, AbortController>();

/** 创建后台 workflow 任务状态并注册 */
export function createWorkflowTask(opts: {
  workflowName: string;
  runId: string;
  source: string;
  description: string;
  toolUseId?: string;
}): { taskState: LocalWorkflowTaskState; abortController: AbortController } {
  const taskId = generateTaskId("local_workflow");
  const output = initTaskOutput(taskId);
  const abortController = new AbortController();

  const taskState: LocalWorkflowTaskState = {
    id: taskId,
    type: "local_workflow",
    status: "running",
    description: opts.description.slice(0, 100),
    toolUseId: opts.toolUseId,
    startTime: Date.now(),
    outputFile: output.filePath,
    outputOffset: 0,
    notified: false,
    workflowName: opts.workflowName,
    runId: opts.runId,
    source: opts.source,
    isBackgrounded: true,
    agentCount: 0,
    progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] },
  };

  registerTask(taskState);
  activeWorkflowControllers.set(taskId, abortController);

  return { taskState, abortController };
}

/** 更新 workflow 进度(agent 数 / 当前 phase / token) */
export function updateWorkflowProgress(
  taskId: string,
  update: { agentCount?: number; currentPhase?: string; progress?: AgentProgress },
): void {
  updateTask<LocalWorkflowTaskState>(taskId, (t) => ({
    ...t,
    ...(update.agentCount !== undefined ? { agentCount: update.agentCount } : {}),
    ...(update.currentPhase !== undefined ? { currentPhase: update.currentPhase } : {}),
    ...(update.progress !== undefined ? { progress: update.progress } : {}),
  }));
}

/** 追加 workflow 输出到磁盘(log() / phase 叙述行) */
export function appendWorkflowOutput(taskId: string, content: string): void {
  appendTaskOutput(taskId, content);
}

/** 标记 workflow 完成 */
export async function completeWorkflowTask(taskId: string, result: AgentTaskResult): Promise<void> {
  await flushTaskOutput(taskId);
  activeWorkflowControllers.delete(taskId);

  const task = getTask(taskId) as LocalWorkflowTaskState | undefined;
  if (!task) return;
  if (isTerminalStatus(task.status)) return; // 终态保护(对称 agent-task)

  updateTask<LocalWorkflowTaskState>(taskId, (t) => ({
    ...t,
    status: "completed",
    result,
    endTime: Date.now(),
    evictAfter: graceDeadlineFor("completed"),
    notified: true,
  }));

  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "completed",
    summary: `Workflow "${task.workflowName}" 执行完成`,
    result,
  });
}

/** 标记 workflow 失败 */
export async function failWorkflowTask(taskId: string, error: string): Promise<void> {
  await flushTaskOutput(taskId);
  activeWorkflowControllers.delete(taskId);

  const task = getTask(taskId) as LocalWorkflowTaskState | undefined;
  if (!task) return;
  if (isTerminalStatus(task.status)) return;

  updateTask<LocalWorkflowTaskState>(taskId, (t) => ({
    ...t,
    status: "failed",
    error,
    endTime: Date.now(),
    evictAfter: graceDeadlineFor("failed"),
    notified: true,
  }));

  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "failed",
    summary: `Workflow "${task.workflowName}" 执行失败`,
    error,
  });
}

/** kill workflow(用户经 task_stop 主动终止) */
export function killWorkflowTask(taskId: string): boolean {
  const controller = activeWorkflowControllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  activeWorkflowControllers.delete(taskId);

  const task = getTask(taskId) as LocalWorkflowTaskState | undefined;
  if (!task || isTerminalStatus(task.status)) return true;

  updateTask<LocalWorkflowTaskState>(taskId, (t) => ({
    ...t,
    status: "killed",
    endTime: Date.now(),
    // killed 走短档（3s，对齐 CC STOPPED_DISPLAY_MS）。见 graceDeadlineFor。
    evictAfter: graceDeadlineFor("killed"),
    notified: true,
  }));

  // 补发 killed 通知,与 complete/fail 对称(对齐 killAgentTask)。
  // 修复缺口:此前设 notified=true 却从不入队通知,导致被 kill 的 workflow 被
  // evictTerminalTasks 静默驱逐、TUI 面板消失、主代理收不到任何通知,无声消失。
  // 落盘 fire-and-forget flush(kill 是同步语义,task_stop 不 await;通知 enqueue
  // 本身同步,不依赖 flush)。
  void flushTaskOutput(taskId).catch(() => {});
  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "killed",
    summary: `Workflow "${task.workflowName}" 已被终止`,
  });
  return true;
}

/** 取 workflow 的中止信号 */
export function getWorkflowTaskSignal(taskId: string): AbortSignal | undefined {
  return activeWorkflowControllers.get(taskId)?.signal;
}
