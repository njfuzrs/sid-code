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
  /**
   * N10：本进程正在**续写**的会话 id（`-c` / `--resume` 恢复的那个旧 id）。
   * 未 resume 时为 undefined（此时 `sessionId` 自己就是在写的那个）。
   *
   * 为什么非它不可：resume 时 `sessionId` 恒是**本进程新生成的 id**（trajectory / PID /
   * crash marker 用它避免跨进程冲突），而 SessionStore 落盘续写的是**旧 id 的 jsonl**。
   * 于是活跃表里登记的 id 与"磁盘上真正在被写的文件名"不是一个东西 ——
   * 别的进程按 `sessionId` 查活跃表，永远查不到"这个旧会话有人正在写"，
   * 于是它满足淘汰条件就被删掉，而续写方全程无感。
   */
  logicalSessionId?: string;
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

/**
 * N10：补登记本进程正在续写的**逻辑会话 id**（resume 之后调用）。
 *
 * 必须是"事后补登记"而不是 registerSession 时一次写全：注册跑在启动早期，
 * 那时还不知道本次要恢复哪个会话（恢复目标在会话选择器 / --resume 解析之后才确定）。
 *
 * 幂等、best-effort：条目不存在或写失败都只告警 —— 它是一道**额外**的跨进程保护，
 * 失败只是退化回"仅本进程保护"，不该让 resume 本身失败。
 */
export function registerLogicalSessionId(sessionId: string, logicalSessionId: string): void {
  try {
    const p = sessionPath(sessionId);
    if (!existsSync(p)) return;
    const entry = JSON.parse(readFileSync(p, "utf-8")) as SessionEntry;
    if (entry.logicalSessionId === logicalSessionId) return;
    entry.logicalSessionId = logicalSessionId;
    writeFileSync(p, JSON.stringify(entry, null, 2));
  } catch (err: any) {
    getLogger().warn("SESSION", `补登记续写会话 id 失败（跨进程保护降级）: ${err?.message ?? err}`);
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
