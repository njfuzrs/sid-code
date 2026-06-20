/**
 * Daemon 形态类型定义
 * ADR-030 / RFC-006 / S8-T07
 */

export interface WorkspaceProvider {
  getWorkdir(): string;
  prepare(opts: { repo: string; branch: string; commit?: string }): Promise<void>;
  cleanup(): Promise<void>;
}

export interface StorageAdapter {
  saveSession(id: string, data: unknown): Promise<void>;
  loadSession(id: string): Promise<unknown | null>;
  deleteSession(id: string): Promise<void>;
  listSessions(): Promise<string[]>;
}

export interface WebhookEvent {
  type: "pull_request" | "ci_failure" | "alert";
  payload: GitHubPREvent | CIFailureEvent | AlertEvent;
  received_at: number;
}

export interface GitHubPREvent {
  action: "opened" | "synchronize" | "reopened";
  number: number;
  repo: string;
  owner: string;
  branch: string;
  base_branch: string;
  commit_sha: string;
  diff_url: string;
  sender: string;
}

export interface CIFailureEvent {
  run_id: string;
  repo: string;
  branch: string;
  commit_sha: string;
  log_url: string;
  failure_step: string;
}

export interface AlertEvent {
  alert_id: string;
  severity: "critical" | "high" | "medium" | "low";
  service: string;
  message: string;
  timestamp: number;
}

export interface DaemonConfig {
  port: number;
  host: string;
  max_concurrent: number;
  webhook_secret: string;
  workspace_base: string;
  storage_type: "file" | "postgres";
  storage_path?: string;
  postgres_url?: string;
  /** 缺口 C1：是否启用调度源（Scheduler 每分钟检查 durable 任务） */
  schedule_enabled?: boolean;
  /** 缺口 C1：调度检查间隔（ms），默认 60_000（每分钟，对齐 cc Desktop） */
  schedule_check_interval_ms?: number;
  /** 缺口 C1：是否监听 HTTP webhook（无 secret 时自动关，纯调度场景不开端口） */
  webhook_enabled?: boolean;
  /** 缺口 C1：headless job 默认超时（ms），默认 30min（对齐 fork 子代理上限） */
  job_timeout_ms?: number;
  /** 缺口 C1 §5.3：全局兜底工具白名单（任务未声明 allowedTools 时使用，默认只读） */
  allowed_tools?: string[];
}

/**
 * 缺口 C1：无头执行任务（webhook worker 与 daemon 调度源共用）。
 * 一份执行器，两个触发源——这是 C1 与 ADR-030 的核心汇合点。
 */
export interface HeadlessJob {
  /** 任务唯一 ID（落盘 / 审计用） */
  jobId: string;
  /** 触发时执行的 prompt */
  prompt: string;
  /** 工作目录（WorkspaceProvider 准备的目录或调度任务的 workspaceDir） */
  workspaceDir: string;
  /** 超时（ms），超时 SIGTERM→SIGKILL */
  timeoutMs: number;
  /** 触发源 */
  source: "schedule" | "webhook";
  /** 预授权工具白名单（注入子进程 --allowed-tools；空=默认只读） */
  allowedTools?: string[];
  /** 指定模型（缺省走 config 默认） */
  model?: string;
}

export interface WorkerResult {
  event_id: string;
  skill: string;
  status: "success" | "error" | "timeout";
  output?: string;
  duration_ms: number;
  error?: string;
}
