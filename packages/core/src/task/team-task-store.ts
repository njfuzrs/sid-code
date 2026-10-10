/**
 * 团队任务列表持久化（P2-2，对齐 CC ~/.claude/tasks/{team}/）
 *
 * 把 structured-task-store 的内存态任务落盘到 `.sid-code/tasks/{team-name}/tasks.json`，
 * 供 swarm team 作为「共享任务列表」调度底座：进程重启可恢复、成员按依赖认领任务。
 *
 * 原子写（temp + rename）防并发/崩溃时半写损坏。
 *
 * 跨进程一致性（多代理 F6）：团队文件按目录共享，两个进程跑同名团队读写同一份 JSON。
 * rename 只保证读不到半截文件，保证不了读到合并后的结果。所以每次写都走
 * 「文件锁 → 重读磁盘 → 按任务合并进内存 → 写回」，认领也在同一把锁里先同步再认领。
 * 锁是 mkdir 互斥（POSIX 下原子），持锁进程崩溃留下的锁按 mtime 超时回收。
 */

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import {
  serializeTeamTasks,
  restoreTeamTasks,
  mergeTeamTasksFromSnapshot,
  claimNextUnblockedTask,
  type StructuredTask,
} from "./structured-task-store.ts";

/** 团队名安全化（与 swarm/team.ts safeName 一致口径），防路径穿越。 */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 团队任务文件路径：{baseDir}/.sid-code/tasks/{team}/tasks.json */
export function teamTasksPath(teamName: string, baseDir?: string): string {
  const base = baseDir ?? process.cwd();
  return join(base, ".sid-code", "tasks", safeName(teamName), "tasks.json");
}

/**
 * 把**该团队分区**的任务快照原子落盘到团队任务文件。
 * 写失败 warn 但不抛（持久化是增益，不应阻断 team 执行）。
 *
 * 注意只落该团队的任务（按 metadata.team 过滤）——此前用全量快照，会把主会话
 * LLM 的 TODO 清单和其他团队的任务一起写进本团队文件，重启恢复时再灌回内存。
 */
export function persistTeamTasks(teamName: string, baseDir?: string): void {
  const path = teamTasksPath(teamName, baseDir);
  try {
    withTeamFileLock(path, () => {
      syncFromDisk(teamName, path);
      writeSnapshot(teamName, path);
    });
  } catch (err: any) {
    getLogger().warn("TEAM_TASKS", `团队任务落盘失败 (${teamName}): ${err?.message ?? err}`);
  }
}

/**
 * 跨进程安全地认领下一个可做的团队任务：锁内先把别的进程的认领同步进来，再认领、再落盘。
 * 不在锁内同步就认领，两个进程会同时把同一个 pending 任务标成自己的（F6 的失败场景）。
 */
export function claimNextTeamTask(
  teamName: string,
  owner: string,
  baseDir?: string,
  opts?: { onlyUnassigned?: boolean },
): StructuredTask | undefined {
  const path = teamTasksPath(teamName, baseDir);
  let claimed: StructuredTask | undefined;
  try {
    withTeamFileLock(path, () => {
      syncFromDisk(teamName, path);
      claimed = claimNextUnblockedTask(owner, teamName, opts);
      if (claimed) writeSnapshot(teamName, path);
    });
  } catch (err: any) {
    getLogger().warn("TEAM_TASKS", `团队任务认领同步失败 (${teamName}): ${err?.message ?? err}`);
    // 落盘层失败不阻断调度：退化为进程内认领（与改造前行为一致）。
    claimed ??= claimNextUnblockedTask(owner, teamName, opts);
  }
  return claimed;
}

/** 读磁盘快照并按任务合并进内存（文件不存在/损坏则跳过）。 */
function syncFromDisk(teamName: string, path: string): void {
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { tasks?: StructuredTask[] };
    if (parsed && Array.isArray(parsed.tasks)) mergeTeamTasksFromSnapshot(teamName, parsed.tasks);
  } catch {
    /* 损坏的文件由本次写覆盖 */
  }
}

function writeSnapshot(teamName: string, path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  // 原子写：先写临时文件再 rename（rename 在同一文件系统内原子），避免读到半写内容。
  const tmp = `${path}.${process.pid}.tmp`;
  const snapshot = serializeTeamTasks(teamName);
  writeFileSync(tmp, JSON.stringify({ version: 1, teamName, tasks: snapshot }, null, 2));
  renameSync(tmp, path);
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * mkdir 互斥锁。调用方都是同步路径（persist 在调度循环里同步调），所以等锁用 Atomics.wait。
 * 等不到锁就不加锁执行并 warn：锁是一致性增益，不能让团队调度卡死在一个陈旧锁上。
 */
function withTeamFileLock(path: string, fn: () => void): void {
  const lockDir = `${path}.lock`;
  mkdirSync(join(path, ".."), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(lockDir);
      locked = true;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue; // 锁刚被释放
      }
      if (Date.now() > deadline) {
        getLogger().warn("TEAM_TASKS", `团队任务文件锁等待超时，无锁写入: ${lockDir}`);
        break;
      }
      Atomics.wait(sleepCell, 0, 0, 10);
    }
  }
  try {
    fn();
  } finally {
    if (locked) {
      try {
        rmdirSync(lockDir);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 从团队任务文件恢复**该团队分区**的任务到内存态（主会话 TODO / 其他团队不受影响）。
 * 文件不存在返回 false（无历史，全新团队）；损坏则 warn 后返回 false（降级为全新）。
 * 成功恢复返回 true。
 */
export function loadTeamTasks(teamName: string, baseDir?: string): boolean {
  const path = teamTasksPath(teamName, baseDir);
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { tasks?: StructuredTask[] };
    if (!parsed || !Array.isArray(parsed.tasks)) {
      getLogger().warn("TEAM_TASKS", `团队任务文件结构非法 (${teamName})，忽略`);
      return false;
    }
    restoreTeamTasks(teamName, parsed.tasks);
    return true;
  } catch (err: any) {
    getLogger().warn(
      "TEAM_TASKS",
      `团队任务文件读取失败 (${teamName})，降级为全新: ${err?.message ?? err}`,
    );
    return false;
  }
}
