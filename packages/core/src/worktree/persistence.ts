/**
 * Worktree Session 持久化与 Resume（P0-1 / P1-9 / D10）
 *
 * 问题：进程重启 / crash 后 worktree 状态全丢，用户需重新 enter。
 *
 * 方案：把当前 session-level worktree 状态写入 .sid-code/session-config.json 的
 * activeWorktreeSession 字段。启动时读取并验证 worktreePath 存在性：
 * - 存在 → 恢复 currentWorktreeSession + 切 cwd（由调用方处理）
 * - 不存在 → 清除持久化状态（worktree 已被外部删除，P1-9）
 *
 * 设计：
 * - 持久化位置 .sid-code/session-config.json（独立文件，不污染项目配置 / settings.json）
 * - 只持久化恢复所需最小字段集（PersistedWorktreeSession，剥离 ephemeral，不变量 §8.7）
 * - 写入按 gitRoot 维度隔离：同一主仓只有一个 session-level worktree（不变量 §8.2）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import type { WorktreeSession, PersistedWorktreeSession } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** session-config.json 中 worktree 相关结构 */
interface SessionConfigFile {
  activeWorktreeSession?: PersistedWorktreeSession;
  [key: string]: unknown;
}

/** 返回持久化文件路径（按 gitRoot 隔离，存于主仓 .sid-code/ 下） */
export function sessionConfigPath(gitRoot: string): string {
  return join(gitRoot, ".sid-code", "session-config.json");
}

/** 读取整个 session-config（容错：不存在 / 损坏返回空对象） */
function readSessionConfig(gitRoot: string): SessionConfigFile {
  const path = sessionConfigPath(gitRoot);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** 写回整个 session-config（保留其它字段） */
function writeSessionConfig(gitRoot: string, config: SessionConfigFile): void {
  const path = sessionConfigPath(gitRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

/** 把运行时 session 剥离为持久化态（去掉 ephemeral 字段，D10） */
function toPersisted(session: WorktreeSession, savedAt: number): PersistedWorktreeSession {
  return {
    originalCwd: session.originalCwd,
    worktreePath: session.worktreePath,
    worktreeName: session.worktreeName,
    worktreeBranch: session.worktreeBranch,
    originalBranch: session.originalBranch,
    originalHeadCommit: session.originalHeadCommit,
    hookBased: session.hookBased,
    tmuxSession: session.tmuxSession,
    savedAt,
  };
}

/** 从持久化态恢复为运行时 session */
function fromPersisted(p: PersistedWorktreeSession): WorktreeSession {
  return {
    originalCwd: p.originalCwd,
    worktreePath: p.worktreePath,
    worktreeName: p.worktreeName,
    sessionId: "",
    worktreeBranch: p.worktreeBranch,
    originalBranch: p.originalBranch,
    originalHeadCommit: p.originalHeadCommit,
    hookBased: p.hookBased,
    tmuxSession: p.tmuxSession,
  };
}

/**
 * 保存当前 session-level worktree 状态（enter / --worktree 创建后调用）。
 * @param savedAt 时间戳（ms），由调用方传入（便于测试 / 避免本模块直接 Date.now()）
 */
export function saveWorktreeState(session: WorktreeSession, savedAt: number = Date.now()): void {
  const log = getLogger();
  try {
    const gitRoot = session.originalCwd;
    const config = readSessionConfig(gitRoot);
    config.activeWorktreeSession = toPersisted(session, savedAt);
    writeSessionConfig(gitRoot, config);
    log.debug("WORKTREE", `已持久化 worktree 状态: ${session.worktreeName}`);
  } catch (err: any) {
    log.warn("WORKTREE", `持久化 worktree 状态失败（不阻断）: ${err.message}`);
  }
}

/**
 * 清除持久化的 worktree 状态（exit / 恢复失败时调用）。
 */
export function clearWorktreeState(gitRoot: string): void {
  const log = getLogger();
  try {
    const config = readSessionConfig(gitRoot);
    if (config.activeWorktreeSession) {
      delete config.activeWorktreeSession;
      writeSessionConfig(gitRoot, config);
      log.debug("WORKTREE", "已清除持久化 worktree 状态");
    }
  } catch (err: any) {
    log.warn("WORKTREE", `清除持久化 worktree 状态失败: ${err.message}`);
  }
}

/** 恢复结果 */
export interface RestoreResult {
  /** 恢复出的 session（null 表示无持久化状态或已失效） */
  session: WorktreeSession | null;
  /** 是否因目录不存在而清除了状态（P1-9） */
  cleared: boolean;
}

/**
 * 启动时恢复 worktree session（P0-1 / P1-9）。
 *
 * 读取持久化状态并验证 worktreePath 存在性：
 * - 不存在 → 清除状态 + 返回 cleared=true（worktree 被外部删除）
 * - 存在 → 返回恢复出的 session（调用方负责 setCurrentWorktreeSession + 切 cwd）
 *
 * 注意：本函数只读取与校验，不修改全局 cwd / session 单例，避免与 bootstrap 时序耦合。
 */
export function restoreWorktreeSession(gitRoot: string): RestoreResult {
  const log = getLogger();
  const config = readSessionConfig(gitRoot);
  const persisted = config.activeWorktreeSession;
  if (!persisted) {
    return { session: null, cleared: false };
  }

  // P1-9：磁盘校验——worktree 目录及其 .git pointer 必须仍存在
  const gitPointer = join(persisted.worktreePath, ".git");
  if (!existsSync(persisted.worktreePath) || !existsSync(gitPointer)) {
    log.warn("WORKTREE", `持久化的 worktree 目录已被外部删除，清除状态: ${persisted.worktreePath}`);
    clearWorktreeState(gitRoot);
    return { session: null, cleared: true };
  }

  log.info("WORKTREE", `恢复 worktree session: ${persisted.worktreeName}`);
  return { session: fromPersisted(persisted), cleared: false };
}

/**
 * 兜底删除整个 session-config 文件（仅测试 / 极端清理用）。
 */
export function removeSessionConfig(gitRoot: string): void {
  try {
    const path = sessionConfigPath(gitRoot);
    if (existsSync(path)) rmSync(path);
  } catch {
    /* 忽略 */
  }
}
