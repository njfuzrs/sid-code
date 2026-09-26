/**
 * 并发会话注册（Spec 18 §4）
 *
 * 每个 sid-code 进程启动时把自己注册到 ~/.sid-code/sessions/<id>.json，
 * 退出时注销。`/ps` 命令读取该目录列出所有活跃会话。
 * 用 PID 探活清理崩溃残留的注册文件（stale）。
 */

import { writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

/** 会话类型 */
export type SessionKind = "interactive" | "headless" | "daemon" | "teammate";

/** 会话注册条目 */
export interface SessionEntry {
  sessionId: string;
  pid: number;
  kind: SessionKind;
  cwd: string;
  startedAt: number;
  /** 可选：所属团队（Swarm teammate 用） */
  team?: string;
  /** 可选：模型 */
  model?: string;
  /**
   * 仅 kind="teammate"：该成员对应的后台 agent 任务 ID。
   * teammate 与主会话同进程，按 PID 探活分不清「成员已结束」和「进程还活着」，
   * 所以 teammate 条目的存活判据是这个任务仍在注册表里且未到终态，而不是 PID。
   */
  taskId?: string;
}

function sessionsDir(): string {
  // 注意：不能用 ~/.sid-code/sessions/（SessionStore 在那里存会话 JSON/JSONL，
  // 会和会话浏览器冲突）。活跃会话注册用独立目录。
  return sidPaths.activeSessions();
}

function sessionPath(sessionId: string): string {
  // 扁平化 id，避免路径穿越
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(sessionsDir(), `${safe}.json`);
}

/** 进程是否存活 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM 表示进程存在但无权限发信号（仍算存活）
    return err?.code === "EPERM";
  }
}

/**
 * 条目是否仍活跃。
 * - 普通会话：看 PID（进程死了就是 stale）。
 * - teammate：同进程子代理，PID 恒为宿主进程。改看其后台任务是否仍在注册表且未终态，
 *   否则成员跑完后 /ps 会一直挂着一条永远不消失的 teammate 会话。
 *   任务注册表查不到（进程重启后内存注册表是空的）也算 stale。
 */
function isSessionEntryAlive(entry: SessionEntry): boolean {
  if (entry.kind === "teammate") {
    if (!entry.taskId) return false;
    try {
      // 延迟 import：session 模块不该在加载期就依赖 task 模块（task 侧也引用会话概念）。
      const { getTask } = require("../task/registry.ts") as {
        getTask: (id: string) => { status: string } | undefined;
      };
      const { isTerminalStatus } = require("../task/types.ts") as {
        isTerminalStatus: (s: string) => boolean;
      };
      const task = getTask(entry.taskId);
      return !!task && !isTerminalStatus(task.status);
    } catch {
      return false;
    }
  }
  return isProcessAlive(entry.pid);
}

/** 注册当前会话 */
export function registerSession(entry: SessionEntry): void {
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(sessionPath(entry.sessionId), JSON.stringify(entry, null, 2));
  } catch (err: any) {
    // 注册失败不应阻塞启动,但需可观测(ERRH-8)
    getLogger().warn("SESSION", `会话注册失败: ${err?.message ?? err}`);
  }
}

/** 注销会话 */
export function unregisterSession(sessionId: string): void {
  try {
    const p = sessionPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
  } catch (err: any) {
    // 注销失败仅遗留 stale 文件,会被 listActiveSessions 清理,但仍记一笔(ERRH-8)
    getLogger().warn("SESSION", `会话注销失败: ${err?.message ?? err}`);
  }
}

/**
 * 列出活跃会话。
 * 顺带清理已死进程的残留注册文件（stale）。
 */
export function listActiveSessions(): SessionEntry[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];

  const active: SessionEntry[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  for (const file of files) {
    const full = join(dir, file);
    let entry: SessionEntry;
    try {
      entry = JSON.parse(readFileSync(full, "utf-8"));
    } catch {
      // 损坏的注册文件，清理
      try {
        unlinkSync(full);
      } catch {
        /* 忽略 */
      }
      continue;
    }

    if (isSessionEntryAlive(entry)) {
      active.push(entry);
    } else {
      // stale：进程已死，清理残留
      try {
        unlinkSync(full);
      } catch {
        /* 忽略 */
      }
    }
  }

  return active.sort((a, b) => a.startedAt - b.startedAt);
}
