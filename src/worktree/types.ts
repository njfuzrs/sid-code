/**
 * Worktree 隔离系统共享类型（对齐 CC，集中定义避免散落）
 *
 * 设计要点：
 * - WorktreeSession 是运行时态，含 ephemeral 字段（创建耗时等）
 * - PersistedWorktreeSession 是磁盘态，剥离 ephemeral 字段，只留恢复所需最小集
 *   （不变量 §8.7：持久化最小化）
 */

/** Worktree 会话状态（运行时） */
export interface WorktreeSession {
  /** 原始工作目录（主仓库 gitRoot） */
  originalCwd: string;
  /** Worktree 路径 */
  worktreePath: string;
  /** Worktree 名称（扁平化 slug） */
  worktreeName: string;
  /** 会话 ID（由调用方填充） */
  sessionId: string;
  /** Worktree 分支名 */
  worktreeBranch: string;
  /** 原始分支名（进入前所在分支） */
  originalBranch?: string;
  /** 创建时的 HEAD commit */
  originalHeadCommit: string;
  /** 是否基于 Hook 创建（remove 时据此分发） */
  hookBased?: boolean;
  /** 关联的 tmux session 名（启用 --tmux 时填充） */
  tmuxSession?: string;
  /** 是否使用了 sparse-checkout（analytics 用） */
  usedSparsePaths?: boolean;
  /** 创建耗时（ms，analytics 用，不持久化） */
  creationDurationMs?: number;
}

/** Worktree 变更统计 */
export interface WorktreeChanges {
  changedFiles: number;
  commits: number;
}

/**
 * 持久化的 Worktree 会话（磁盘态）。
 * 剥离 ephemeral 字段（creationDurationMs），只保留 resume 所需的最小集。
 */
export interface PersistedWorktreeSession {
  originalCwd: string;
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  originalBranch?: string;
  originalHeadCommit: string;
  hookBased?: boolean;
  tmuxSession?: string;
  /** 持久化时间戳（ms），用于判断陈旧度 */
  savedAt: number;
}

/** create() 选项 */
export interface CreateWorktreeOptions {
  /** PR 编号：fetch pull/<n>/head 后创建 worktree */
  prNumber?: number;
  /** 基准 ref：覆盖 settings.worktree.baseRef */
  baseRef?: string;
  /** 关联的 session id */
  sessionId?: string;
}
