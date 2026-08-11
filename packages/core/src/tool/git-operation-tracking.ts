/**
 * Git 操作使用度量（P2-3）— 全局单例计数器 + 观察者
 *
 * 目标：让 commit / push / PR 创建等 git 操作有可观测的使用计数（此前全库缺失），
 * 对齐「以可度量的轨迹数据为底座」的北极星。
 *
 * 设计沿用 side-call-sink 的轻量模式：模块级计数器 + 观察者回调，
 * 避免在 bash 工具执行点持有 sessionState / traceCollector（传参改面太大）。
 *
 * 使用方式：
 *   1. bash 命令**成功执行后**（exitCode===0）调用 recordGitOperation(command)。
 *   2. app.ts 启动时用 setGitOperationObserver 注入观察者，把事件透传给 trace/telemetry。
 *   3. getGitOperationStats() 读累加值；resetGitOperationStats() 在会话初始化时重置
 *      （同进程内 resume/新会话不串味）。
 */

import { normalizeGitGlobalOptions } from "../permission/git-danger-patterns.ts";

/** git 操作分类 */
export type GitOperationKind =
  | "commit"
  | "push"
  | "pr_created"
  | "merge"
  | "rebase"
  | "checkout"
  | "reset"
  | "other";

export interface GitOperationEvent {
  kind: GitOperationKind;
  /** 触发命令（截断，避免落盘超长/敏感内容） */
  command: string;
  timestamp: number;
}

export interface GitOperationStats {
  total: number;
  byKind: Record<GitOperationKind, number>;
  events: GitOperationEvent[];
}

function emptyByKind(): Record<GitOperationKind, number> {
  return {
    commit: 0, push: 0, pr_created: 0, merge: 0,
    rebase: 0, checkout: 0, reset: 0, other: 0,
  };
}

let _byKind = emptyByKind();
let _events: GitOperationEvent[] = [];
let _observer: ((event: GitOperationEvent) => void) | null = null;

/**
 * 把一条 bash 命令分类为 git 操作类型；非 git 操作返回 null。
 *
 * 注意：只识别「有意义的写/动作类」git 操作用于度量，只读（status/log/diff）不计数。
 * PR 创建识别 `gh pr create` / `glab mr create` / `cr`（对齐 git_safety 的 PR CLI 约定）。
 */
export function classifyGitOperation(command: string): GitOperationKind | null {
  if (!command) return null;
  // git 全局选项容错（对齐 CC gitCmdRe）：`git -c commit.gpgsign=false commit`、
  // `git -C dir push`、`git --no-pager log` 会把子命令与 `git` 撑开，
  // 不归一化则所有 `\bgit\s+<子命令>` 正则失配 → 这些操作漏计数。
  const c = normalizeGitGlobalOptions(command.trim());

  // PR / MR 创建（非 git 子命令，但属 git 工作流度量）
  if (/\bgh\s+pr\s+create\b/.test(c)) return "pr_created";
  if (/\bglab\s+mr\s+create\b/.test(c)) return "pr_created";
  // Amazon code review 提交（cr）——仅在明确是 cr 创建时
  if (/\bcr\s+(create|submit)\b/.test(c)) return "pr_created";

  // 必须是 git 命令
  if (!/\bgit\b/.test(c)) return null;

  // 提交（排除只读的 --dry-run）
  if (/\bgit\s+commit\b/.test(c) && !/--dry-run\b/.test(c)) return "commit";
  if (/\bgit\s+push\b/.test(c)) return "push";
  if (/\bgit\s+merge\b/.test(c)) return "merge";
  if (/\bgit\s+rebase\b/.test(c)) return "rebase";
  if (/\bgit\s+(checkout|switch)\b/.test(c)) return "checkout";
  if (/\bgit\s+reset\b/.test(c)) return "reset";

  return null;
}

/**
 * 注册 git 操作观察者（app.ts 启动时注入，把事件透传 trace/telemetry）。
 */
export function setGitOperationObserver(fn: ((event: GitOperationEvent) => void) | null): void {
  _observer = fn;
}

/**
 * 记录一次 git 操作（应在命令**成功执行后**调用）。
 * 非 git 操作静默忽略。
 *
 * @param command 执行的命令
 * @param timestamp 时间戳（由调用方传入，避免此模块依赖 Date.now 便于测试）
 */
export function recordGitOperation(command: string, timestamp: number): GitOperationEvent | null {
  const kind = classifyGitOperation(command);
  if (!kind) return null;

  const event: GitOperationEvent = {
    kind,
    command: command.slice(0, 200),
    timestamp,
  };
  _byKind[kind]++;
  _events.push(event);
  // 观察者失败不影响主流程
  try { _observer?.(event); } catch { /* 静默 */ }
  return event;
}

/** 读取累计统计（快照拷贝，避免外部改内部状态）。 */
export function getGitOperationStats(): GitOperationStats {
  const total = Object.values(_byKind).reduce((a, b) => a + b, 0);
  return {
    total,
    byKind: { ..._byKind },
    events: [..._events],
  };
}

/** 重置统计（SessionStart 时调用）。 */
export function resetGitOperationStats(): void {
  _byKind = emptyByKind();
  _events = [];
}
