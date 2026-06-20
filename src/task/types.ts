/**
 * Task 类型体系
 * 统一的并发执行单元抽象，为后台 Shell 和后台 Agent 提供共享的类型定义
 */

import { randomBytes } from "crypto";

/** 任务类型 */
export type TaskType = "local_shell" | "local_agent" | "local_workflow";

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

/** Agent 任务结构化结果（对标 claude-code AgentToolResult）
 *  替代原来的纯字符串 result，保留 usage、工具调用次数等结构化信息 */
export interface AgentTaskResult {
  /** 文本输出（子代理的最终结论） */
  output: string;
  /** 工具调用次数 */
  totalToolUseCount: number;
  /** 总 token 消耗 */
  totalTokens: number;
  /** LLM 用量明细 */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
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
  result?: AgentTaskResult;
  error?: string;
  isBackgrounded: boolean;
  progress?: AgentProgress;
  /** 周期性进度摘要（M5 opt-in 双轨特性） */
  progressSummary?: string;
}

/** Workflow 任务状态（Dynamic Workflows M6:后台运行的编排脚本） */
export interface LocalWorkflowTaskState extends TaskStateBase {
  type: "local_workflow";
  /** workflow 名(来自脚本 meta.name) */
  workflowName: string;
  /** 运行 ID(wf_<...>,用于 resume) */
  runId: string;
  /** 脚本来源摘要(name / scriptPath / inline) */
  source: string;
  /** 已发起的 agent 调用数(进度可观测) */
  agentCount?: number;
  /** 当前 phase 标题 */
  currentPhase?: string;
  /** 完成后的结构化结果(JSON 序列化) */
  result?: AgentTaskResult;
  error?: string;
  isBackgrounded: boolean;
  progress?: AgentProgress;
}

/** 联合类型 */
export type TaskState = LocalShellTaskState | LocalAgentTaskState | LocalWorkflowTaskState;

/** 类型守卫 */
export function isShellTask(task: TaskState): task is LocalShellTaskState {
  return task.type === "local_shell";
}

export function isAgentTask(task: TaskState): task is LocalAgentTaskState {
  return task.type === "local_agent";
}

export function isWorkflowTask(task: TaskState): task is LocalWorkflowTaskState {
  return task.type === "local_workflow";
}

/** Task ID 生成：类型前缀 + 8 位随机字符 */
const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_shell: "s",
  local_agent: "a",
  local_workflow: "w",
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
