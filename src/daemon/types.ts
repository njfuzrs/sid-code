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
}

export interface WorkerResult {
  event_id: string;
  skill: string;
  status: "success" | "error" | "timeout";
  output?: string;
  duration_ms: number;
  error?: string;
}
