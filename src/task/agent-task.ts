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
import { registerTask, updateTask, getTask, EVICT_GRACE_MS } from "./registry.ts";
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

  // 终态保护：若任务已被 kill（killed 终态），不覆盖成 completed、不重复发通知。
  // 与 failAgentTask 对称，防 abort 后子代理碰巧返回成功结果反把 killed 改写。
  if (isTerminalStatus(task.status)) return;

  updateTask<LocalAgentTaskState>(taskId, (t) => ({
    ...t,
    status: "completed",
    result,
    endTime: Date.now(),
    evictAfter: Date.now() + EVICT_GRACE_MS,  // 对标 CC: 60s 缓冲期后才允许驱逐
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

  // 终态保护：若任务已是 killed/completed/failed，不覆盖、不重复发通知。
  // 修复缺口：用户经 task_stop → killAgentTask 主动终止时已设 killed 终态，
  // 随后后台 execute 因 abort 走 failAgentTask，此前会把 killed 覆盖成 failed
  // 并误发"执行失败"通知。对标 claude-code：AbortError 走 killed 而非 failed。
  if (isTerminalStatus(task.status)) return;

  updateTask<LocalAgentTaskState>(taskId, (t) => ({
    ...t,
    status: "failed",
    error,
    endTime: Date.now(),
    evictAfter: Date.now() + EVICT_GRACE_MS,  // 对标 CC: 60s 缓冲期后才允许驱逐
    notified: true,
  }));

  enqueuePendingNotification(
    formatNotification({
      taskId,
      toolUseId: task.toolUseId,
      outputFile: task.outputFile,
      status: "failed",
      summary: `Agent "${task.description}" 执行失败: ${error.length > 200 ? error.slice(0, 200) + "…[截断]" : error}`,
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

  const task = getTask(taskId) as LocalAgentTaskState | undefined;
  // 已终态：仅 abort（上面已做），不重复改状态、不重复发通知（幂等）。
  if (!task || isTerminalStatus(task.status)) return;

  updateTask<LocalAgentTaskState>(taskId, (t) => {
    if (isTerminalStatus(t.status)) return t;
    return {
      ...t,
      status: "killed",
      endTime: Date.now(),
      evictAfter: Date.now() + EVICT_GRACE_MS,  // 对标 CC: 60s 缓冲期后才允许驱逐
      notified: true,
    };
  });

  // 补发 killed 通知，与 complete/fail 对称。
  // 修复缺口：killAgentTask 此前设 notified=true 却从不入队通知，
  // 导致被 kill 的任务被 evictTerminalTasks 静默驱逐、用户既看不到面板条目
  // 也收不到任何通知，任务无声消失。落盘输出 fire-and-forget flush（kill 是
  // 同步语义，task_stop 不 await；通知 enqueue 本身同步，不依赖 flush）。
  void flushTaskOutput(taskId).catch(() => {});
  enqueuePendingNotification(
    formatNotification({
      taskId,
      toolUseId: task.toolUseId,
      outputFile: task.outputFile,
      status: "killed",
      summary: `Agent "${task.description}" 已被终止`,
    }),
  );
}

/** 获取 Agent 任务的 AbortSignal */
export function getAgentTaskSignal(taskId: string): AbortSignal | undefined {
  return activeAgentControllers.get(taskId)?.signal;
}
