/**
 * LocalAgentTask — 后台 Agent 任务执行
 * 管理后台 Agent 的生命周期，完成后通知主循环
 */

import {
  generateTaskId,
  type LocalAgentTaskState,
  type AgentProgress,
  type AgentTaskResult,
  isTerminalStatus,
} from "./types.ts";
import { registerTask, updateTask, getTask } from "./registry.ts";
import { initTaskOutput, appendTaskOutput, flushTaskOutput } from "./disk-output.ts";
import {
  formatNotification,
  enqueuePendingNotification,
} from "./notification.ts";

/** 活跃 Agent 的 AbortController（用于 kill） */
const activeAgentControllers = new Map<string, AbortController>();

/** 创建后台 Agent 任务状态并注册 */
export function createAgentTask(opts: {
  agentType: string;
  prompt: string;
  description: string;
  toolUseId?: string;
  model?: string;
}): { taskState: LocalAgentTaskState; abortController: AbortController } {
  const taskId = generateTaskId("local_agent");
  const output = initTaskOutput(taskId);
  const abortController = new AbortController();

  const taskState: LocalAgentTaskState = {
    id: taskId,
    type: "local_agent",
    status: "running",
    description: opts.description.slice(0, 100),
    toolUseId: opts.toolUseId,
    startTime: Date.now(),
    outputFile: output.filePath,
    outputOffset: 0,
    notified: false,
    agentId: taskId,
    agentType: opts.agentType,
    prompt: opts.prompt,
    model: opts.model,
    isBackgrounded: true,
    progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] },
  };

  registerTask(taskState);
  activeAgentControllers.set(taskId, abortController);

  return { taskState, abortController };
}

/** 更新 Agent 任务进度 */
export function updateAgentProgress(taskId: string, progress: AgentProgress): void {
  updateTask<LocalAgentTaskState>(taskId, (t) => ({
    ...t,
    progress,
  }));
}

/** 追加 Agent 输出到磁盘 */
export function appendAgentOutput(taskId: string, content: string): void {
  appendTaskOutput(taskId, content);
}

/** 标记 Agent 任务完成（接受结构化结果） */
export async function completeAgentTask(taskId: string, result: AgentTaskResult): Promise<void> {
  await flushTaskOutput(taskId);
  activeAgentControllers.delete(taskId);

  const task = getTask(taskId) as LocalAgentTaskState | undefined;
  if (!task) return;

  updateTask<LocalAgentTaskState>(taskId, (t) => ({
    ...t,
    status: "completed",
    result,
    endTime: Date.now(),
    notified: true,
  }));

  enqueuePendingNotification(
    formatNotification({
      taskId,
      toolUseId: task.toolUseId,
      outputFile: task.outputFile,
      status: "completed",
      summary: `Agent "${task.description}" 执行完成`,
      result,
    }),
  );
}

/** 标记 Agent 任务失败 */
export async function failAgentTask(taskId: string, error: string): Promise<void> {
  await flushTaskOutput(taskId);
  activeAgentControllers.delete(taskId);

  const task = getTask(taskId) as LocalAgentTaskState | undefined;
  if (!task) return;

  updateTask<LocalAgentTaskState>(taskId, (t) => ({
    ...t,
    status: "failed",
    error,
    endTime: Date.now(),
    notified: true,
  }));

  enqueuePendingNotification(
    formatNotification({
      taskId,
      toolUseId: task.toolUseId,
      outputFile: task.outputFile,
      status: "failed",
      summary: `Agent "${task.description}" 执行失败: ${error.slice(0, 200)}`,
    }),
  );
}

/** 终止 Agent 任务 */
export function killAgentTask(taskId: string): void {
  const controller = activeAgentControllers.get(taskId);
  if (controller) {
    controller.abort();
    activeAgentControllers.delete(taskId);
  }

  updateTask<LocalAgentTaskState>(taskId, (t) => {
    if (isTerminalStatus(t.status)) return t;
    return {
      ...t,
      status: "killed",
      endTime: Date.now(),
      notified: true,
    };
  });
}

/** 获取 Agent 任务的 AbortSignal */
export function getAgentTaskSignal(taskId: string): AbortSignal | undefined {
  return activeAgentControllers.get(taskId)?.signal;
}
