/**
 * 启动维护子进程的落盘状态：单实例锁、按任务的水位线、结果文件。
 *
 * 三个文件都在 `~/.sid-code/state/` 下，都是小 JSON：TUI 进程判「要不要拉起子进程」时
 * 只读水位线文件，O(1)，不随数据量增长——这是能留在 TUI 进程里的唯一一部分。
 *
 * 不复用 `daemon/lock.ts`：那把锁的路径写死为 daemon.lock，且语义是「本机只有一个守护进程」；
 * 这里是另一把锁，模式相同（wx 原子创建 + PID 探活回收 stale）。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";

/** 维护任务闭集。新增任务要同时给出间隔（{@link TASK_INTERVAL_MS}） */
export type MaintenanceTask =
  | "session-cleanup"
  | "trace-prune"
  | "housekeeping"
  | "trace-upload"
  | "worktree-gc";

/**
 * 各任务的最小间隔。housekeeping 不在这里：它沿用自己既有的 `.last-cleanup` 水位线
 * （startup-housekeeping.ts 的 shouldRunCleanup），不另起一份，免得两份水位线漂移。
 */
export const TASK_INTERVAL_MS: Record<Exclude<MaintenanceTask, "housekeeping">, number> = {
  "session-cleanup": 24 * 60 * 60 * 1000,
  "trace-prune": 24 * 60 * 60 * 1000,
  // U1–U4（PR-C）：补传 + 重试队列。单个会话的失败另有跨进程退避（trace/upload-attempts.ts），
  // 这里只限「多久扫一次」。1h 而不是 24h：补传是轨迹上云唯一真正生效的自动路径（0/52 事故）。
  "trace-upload": 60 * 60 * 1000,
  // X1（PR-D）：过期临时 worktree 清理。判据是 30 天未活动，一天扫一次足够；
  // 原先每次启动都在 TUI 进程里同步 `git worktree prune`（本仓实测 30–80ms）。
  "worktree-gc": 24 * 60 * 60 * 1000,
};

interface WatermarkFile {
  tasks: Partial<Record<MaintenanceTask, number>>;
}

function watermarkPath(): string {
  return sidPaths.stateFile("maintenance-watermarks.json");
}
function resultPath(): string {
  return sidPaths.stateFile("maintenance-result.json");
}
function lockPath(): string {
  return sidPaths.stateFile("maintenance.lock");
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown, flag?: "wx"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), flag ? { flag } : undefined);
}

/** 某任务距上次成功完成是否已超过间隔（水位线缺失或损坏视为到期） */
export function isTaskDue(
  task: Exclude<MaintenanceTask, "housekeeping">,
  now: number = Date.now(),
): boolean {
  const last = readJson<WatermarkFile>(watermarkPath())?.tasks?.[task];
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  return now - last >= TASK_INTERVAL_MS[task];
}

/** 任务成功完成后刷新水位线（读-改-写；写失败只意味着下次再跑一遍） */
export function markTaskDone(task: MaintenanceTask, now: number = Date.now()): void {
  try {
    const cur = readJson<WatermarkFile>(watermarkPath()) ?? { tasks: {} };
    cur.tasks = { ...cur.tasks, [task]: now };
    writeJson(watermarkPath(), cur);
  } catch {
    /* 最坏下次启动再跑一遍，方向是多做不是少做 */
  }
}

// ─── 单实例锁 ───

interface LockContent {
  pid: number;
  startedAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** 抢锁。已有存活的维护进程返回 false；持有者已死则回收后再抢 */
export function tryAcquireMaintenanceLock(): boolean {
  const path = lockPath();
  try {
    const existing = readJson<LockContent>(path);
    if (existing) {
      if (typeof existing.pid === "number" && isProcessAlive(existing.pid)) return false;
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
    } else if (existsSync(path)) {
      // 锁文件损坏（读不出 JSON）：可能是另一个进程正在写，保守放弃这一轮
      return false;
    }
    writeJson(path, { pid: process.pid, startedAt: Date.now() } satisfies LockContent, "wx");
    return true;
  } catch {
    return false;
  }
}

/** 释放锁（仅当自己持有时） */
export function releaseMaintenanceLock(): void {
  try {
    const existing = readJson<LockContent>(lockPath());
    if (existing?.pid === process.pid) unlinkSync(lockPath());
  } catch {
    /* 忽略：下一个进程会按 PID 探活回收 */
  }
}

// ─── 结果文件：子进程写，下一次启动的 TUI 读 ───

export interface MaintenanceTaskResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface MaintenanceResult {
  pid: number;
  startedAt: number;
  finishedAt: number;
  /** 子进程自身的内存峰值（字节，来自 process.resourceUsage().maxRSS） */
  peakRssBytes?: number;
  tasks: Partial<Record<MaintenanceTask, MaintenanceTaskResult>>;
  /** 补传结果摘要（formatBackfillResult / formatQueueResult 同口径，排查用） */
  traceUpload?: { backfill: string; queue: string; newlyFailedTerminal: number };
  /** 会话清理删除数（> 0 时下次启动要提示用户，Claude Code#64999「删用户数据必须让人看见」） */
  sessionCleanup?: { deleted: number; maxAge?: string };
}

export function writeMaintenanceResult(result: MaintenanceResult): void {
  try {
    writeJson(resultPath(), result);
  } catch {
    /* 结果是诊断与提示用，写失败不影响清理本身 */
  }
}

export function readMaintenanceResult(): MaintenanceResult | null {
  return readJson<MaintenanceResult>(resultPath());
}

/**
 * 取出「还没提示过」的会话清理结论，并把它标记为已提示（同一个结论只提示一次）。
 * 只读写一个小文件，O(1)。
 */
export function consumeSessionCleanupNotice(): { deleted: number; maxAge?: string } | null {
  const r = readMaintenanceResult();
  if (!r?.sessionCleanup || r.sessionCleanup.deleted <= 0) return null;
  const notice = r.sessionCleanup;
  writeMaintenanceResult({ ...r, sessionCleanup: undefined });
  return notice;
}
