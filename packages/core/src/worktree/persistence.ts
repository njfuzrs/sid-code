/**
 * Worktree Session 持久化与 Resume（P0-1 / P1-9 / D10）
 *
 * 问题：进程重启 / crash 后 worktree 状态全丢，用户需重新 enter。
 *
 * 方案：把当前 session-level worktree 状态写入 .sid-code/session-config.json 的
 * activeWorktreeSession 字段，并记下拥有它的**逻辑会话 id**。启动时：
 * - 本次显式 resume / continue 的就是拥有者会话，且目录还在 → 恢复 + 切 cwd
 * - 其余一切情况（普通启动、resume 别的会话、旧状态没有 sessionId）→ 不切 cwd，状态原样保留
 * - 目录不存在 → 清除持久化状态（worktree 已被外部删除，P1-9）
 *
 * 为什么判据是「本次 resume 的是不是拥有者」而不是「拥有者会话结束了没有」：
 * 退出状态的唯一入口是显式 exit_worktree，关终端 / /quit / 任务做完都不清它。
 * 之前用「会话 jsonl 最后一条是 session_end」判结束，没查到就当崩溃、照常进入——
 * 而实测本机最近 23 个会话只有 12 个以 session_end 结尾，于是普通启动被成批
 * chdir 进别的会话留下的 worktree，横幅显示错误的分支，编辑落进错误的目录。
 * 「worktree 是会话的现场」：只有接续那个会话时才该回到那个现场，
 * 这条判据不依赖任何退出路径有没有写成功。
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
import { getSessionId } from "../bootstrap/state.ts";

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

/**
 * 本进程正在续写的逻辑会话 id（resume / continue 时由 cli 回填）。
 *
 * 必须是逻辑 id 而不是 bootstrap 的进程 id：resume 时进程 id 恒是新生成的，
 * 而下次 `--resume` 匹配的是 jsonl 的会话 id。落盘进程 id 的话，一个被续写过的
 * 会话进了 worktree，之后再怎么 resume 它也对不上，现场永远回不去。
 * 放在本模块而不是 bootstrap/state：它只有这一个读者，不值得扩大全局状态。
 */
let ownerSessionIdOverride: string | undefined;

/** cli 在会话恢复目标确定后调用；传空值撤销。 */
export function setWorktreeOwnerSessionId(id: string | undefined): void {
  ownerSessionIdOverride = id || undefined;
}

/** 把运行时 session 剥离为持久化态（去掉 ephemeral 字段，D10） */
function toPersisted(session: WorktreeSession, savedAt: number): PersistedWorktreeSession {
  // 优先级：调用方显式给的 id > 本进程续写的逻辑会话 id > 进程全局 id。
  // 都没有时不写字段——那种状态无从判断归属，启动时不会被自动进入。
  const sessionId = session.sessionId || ownerSessionIdOverride || getSessionId() || undefined;
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
    ...(sessionId ? { sessionId } : {}),
  };
}

/** 从持久化态恢复为运行时 session */
function fromPersisted(p: PersistedWorktreeSession): WorktreeSession {
  return {
    originalCwd: p.originalCwd,
    worktreePath: p.worktreePath,
    worktreeName: p.worktreeName,
    sessionId: p.sessionId ?? "",
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

/**
 * 启动时要不要自动进入这份持久化的 worktree。
 *
 * 只有一条放行路径：本次显式接续（--resume / --continue / 选择器）的会话，
 * 正是进入这个 worktree 的那个会话。其余一律不进：
 * - 普通启动 → 新会话，不继承任何别的会话的现场；
 * - resume 的是别的会话 → 那个会话的现场不在这里；
 * - 旧状态没有 sessionId → 证明不了归属，宁可不进（用户可再 enter_worktree）。
 *
 * 刻意不看「拥有者会话结束了没有」：那要靠退出路径写成功一条记录，
 * 而退出路径（关终端、kill、崩溃）恰恰是最不可靠的地方。
 * 纯函数、不读不写磁盘——调用方拿到 false 后状态原样保留，
 * 下次 resume 拥有者时仍能回到现场。
 */
export function shouldAutoEnterWorktree(
  session: { sessionId?: string },
  resumeSessionId?: string,
): boolean {
  return !!session.sessionId && !!resumeSessionId && resumeSessionId === session.sessionId;
}

/** 恢复结果 */
export interface RestoreResult {
  /** 恢复出的 session（null 表示无持久化状态或已失效） */
  session: WorktreeSession | null;
  /** 是否因目录不存在而清除了状态（P1-9）。会话已结束的放弃由调用方判定。 */
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

  // 归属判定（shouldAutoEnterWorktree）放在调用方：本次要接续的会话 id 在启动流程里
  // 比本函数晚解析（--resume 选择器、--from-pr 都在后面）。
  // 本函数只回答「磁盘上这份状态还有效吗」，进不进由 cli 在 id 已知后决定。
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
