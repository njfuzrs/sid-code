/**
 * Task 类型体系
 * 统一的并发执行单元抽象，为后台 Shell 和后台 Agent 提供共享的类型定义
 */

import { randomBytes } from "crypto";

/** 任务类型 */
export type TaskType = "local_shell" | "local_agent";

/** 任务状态机：pending → running → completed | failed | killed */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

/** Agent 进度信息 */
export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
  activityDescription?: string;
}

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities: ToolActivity[];
}

/** 任务状态基类 */
export interface TaskStateBase {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  outputFile: string;
  outputOffset: number;
  notified: boolean;
}

/** Shell 任务状态 */
export interface LocalShellTaskState extends TaskStateBase {
  type: "local_shell";
  command: string;
  exitCode?: number;
  interrupted: boolean;
  isBackgrounded: boolean;
  agentId?: string;
}

/** Agent 任务状态 */
export interface LocalAgentTaskState extends TaskStateBase {
  type: "local_agent";
  agentId: string;
  agentType: string;
  prompt: string;
  model?: string;
  result?: string;
  error?: string;
  isBackgrounded: boolean;
  progress?: AgentProgress;
}

/** 联合类型 */
export type TaskState = LocalShellTaskState | LocalAgentTaskState;

/** 类型守卫 */
export function isShellTask(task: TaskState): task is LocalShellTaskState {
  return task.type === "local_shell";
}

export function isAgentTask(task: TaskState): task is LocalAgentTaskState {
  return task.type === "local_agent";
}

/** Task ID 生成：类型前缀 + 8 位随机字符 */
const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_shell: "s",
  local_agent: "a",
};

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type];
  const bytes = randomBytes(8);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return id;
}
