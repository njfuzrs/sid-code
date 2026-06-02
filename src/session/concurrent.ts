/**
 * 并发会话注册（Spec 18 §4）
 *
 * 每个 sid-code 进程启动时把自己注册到 ~/.sid-code/sessions/<id>.json，
 * 退出时注销。`/ps` 命令读取该目录列出所有活跃会话。
 * 用 PID 探活清理崩溃残留的注册文件（stale）。
 */

import {
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

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
}

function sessionsDir(): string {
  // 注意：不能用 ~/.sid-code/sessions/（SessionStore 在那里存会话 JSON/JSONL，
  // 会和会话浏览器冲突）。活跃会话注册用独立目录。
  return join(homedir(), ".sid-code", "active-sessions");
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

/** 注册当前会话 */
export function registerSession(entry: SessionEntry): void {
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(sessionPath(entry.sessionId), JSON.stringify(entry, null, 2));
  } catch {
    /* 注册失败不应阻塞启动 */
  }
}

/** 注销会话 */
export function unregisterSession(sessionId: string): void {
  try {
    const p = sessionPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* 忽略 */
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

    if (isProcessAlive(entry.pid)) {
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
