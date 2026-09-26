/**
 * Worktree Session 持久化与 Resume（P0-1 / P1-9 / D10）
 *
 * 问题：进程重启 / crash 后 worktree 状态全丢，用户需重新 enter。
 *
 * 方案：把当前 session-level worktree 状态写入 .sid-code/session-config.json 的
 * activeWorktreeSession 字段。启动时读取并验证 worktreePath 存在性：
 * - 存在，且拥有它的会话还活着（或本次就是 resume 那个会话）→ 恢复 + 切 cwd
 * - 存在，但拥有它的会话已经正常结束 → 清除状态，不切 cwd（目录与分支保留）
 * - 不存在 → 清除持久化状态（worktree 已被外部删除，P1-9）
 *
 * 为什么要问「会话还活着」而不只问「目录还在」：enter 会落盘，但退出状态的
 * 唯一入口是显式 exit_worktree。关终端、/quit、任务做完都不会清它，于是下一次
 * 普通启动被 chdir 进一个已经没人用的 worktree，横幅跟着显示错误的分支。
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
import { resolveSessionFileAcrossProjects, flushPendingSessionWrites } from "../session/store.ts";
import { isProcessAlive, listActiveSessions } from "../session/concurrent.ts";

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
  // 优先用调用方显式给的 id；缺省回退到进程全局。全局没人回填时是空串，
  // 那种状态落盘也无从判断归属，按「没有 sessionId」处理（恢复时保持原行为）。
  const sessionId = session.sessionId || getSessionId() || undefined;
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
 * 拥有这份 worktree 状态的会话是否已经结束。
 *
 * 判据只有两个，都是磁盘上的事实，不靠时间猜：
 * - 活跃会话注册表里它的 pid 还活着 → 没结束。同一会话开着第二个终端时，
 *   新进程不该把对方正在用的 worktree 状态清掉。
 * - 会话 jsonl 的**最后一条**记录是 `session_end` → 已结束。`session_end`
 *   是同步落盘的关键记录（store.ts 的 writeCritical），关终端 / /quit /
 *   正常退出都会留下它；而 `--resume` 续写会在它后面追加新记录，
 *   所以「最后一条」而不是「出现过」才是对的——出现过但后面又续写了，
 *   说明这个会话又活了。
 *
 * 读不到（没有 sessionId、文件不存在、解析失败）一律返回 false：
 * 无法判断时保持原有恢复行为，不能把「没查到」当成「已经结束」。
 */
export function isWorktreeOwnerEnded(sessionId: string | undefined): boolean {
  if (!sessionId) return false;

  // 注册表读失败 ≠ 会话已结束：吞掉异常继续看 jsonl。
  // listActiveSessions 顺手删掉进程已死的残留条目，那是它既有的职责，这里只读结果。
  try {
    if (listActiveSessions().some((e) => e.sessionId === sessionId && isProcessAlive(e.pid))) {
      return false;
    }
  } catch {
    /* 继续看 jsonl */
  }

  return sessionJsonlEndsWith(sessionId, "session_end");
}

/**
 * 会话 jsonl 的最后一条可解析记录是不是指定类型。
 *
 * 只读、不改任何状态。文件不存在、不是 jsonl、读失败都返回 false——
 * 「没查到」不能当成「是这个类型」。半行损坏的记录跳过，不推翻前面读到的类型。
 */
function sessionJsonlEndsWith(sessionId: string, type: string): boolean {
  let file: string | null;
  try {
    // 先把同进程内还在缓冲的写入落盘，否则会读到落后于内存的内容
    flushPendingSessionWrites();
    file = resolveSessionFileAcrossProjects(sessionId);
  } catch {
    return false;
  }
  if (!file || !file.endsWith(".jsonl")) return false;

  let lastType = "";
  try {
    const content = readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { type?: unknown };
        if (typeof rec.type === "string") lastType = rec.type;
      } catch {
        /* 半行损坏跳过 */
      }
    }
  } catch {
    return false;
  }
  return lastType === type;
}

/**
 * 启动时要不要自动进入这份持久化的 worktree。
 *
 * 纯判定，不读不写 session-config：调用方拿到 false 后再决定清状态。
 * 拆出来是因为「本次要恢复哪个会话」在启动流程里比 worktree 恢复晚解析
 * （--resume 选择器、--from-pr 都在后面），判定必须接在那个 id 已知之后。
 *
 * - 没有 sessionId 的旧状态无从判断归属 → 保持原行为，进入。
 * - 本次就是 resume 拥有它的那个会话 → 进入（现场还在，正是要恢复的）。
 * - 拥有者会话已结束 → 不进入。
 * - 其余（会话还开着、崩溃没写 session_end、jsonl 读不到）→ 进入。
 */
export function shouldAutoEnterWorktree(
  session: { sessionId?: string },
  resumeSessionId?: string,
): boolean {
  if (!session.sessionId) return true;
  if (resumeSessionId && resumeSessionId === session.sessionId) return true;
  return !isWorktreeOwnerEnded(session.sessionId);
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

  // 归属校验放在调用方而不是这里：本次要 resume 的会话 id 在启动流程里
  // 比本函数晚解析（--resume 选择器、--from-pr 都在后面），此刻判断
  // 「是不是正在恢复拥有者」必然拿不到那个 id，会把正要恢复的现场提前清掉。
  // 本函数只回答「磁盘上这份状态还有效吗」，是否因会话已结束而放弃由 cli 决定。
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
