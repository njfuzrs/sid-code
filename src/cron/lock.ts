/**
 * 调度器锁（Spec 18 §5.3.5）
 *
 * 多个 sid-code 会话同时跑时，只允许一个持有"持久任务调度权"，
 * 避免同一持久 cron 任务被多个进程重复触发。
 * 会话级（非 durable）任务不需要锁——它们只活在本进程内存里。
 *
 * 锁文件记录持有者 PID，通过 PID 探活回收崩溃残留的锁（stale）。
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

const LOCK_FILE = ".sid-code/scheduled_tasks.lock";

interface LockContent {
  sessionId: string;
  pid: number;
  acquiredAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * 尝试获取调度器锁。
 * 成功返回 true；锁被存活进程持有返回 false（fail-closed：不确定时不抢锁）。
 */
export function tryAcquireSchedulerLock(dir: string, sessionId: string): boolean {
  const lockPath = join(dir, LOCK_FILE);
  const content: LockContent = {
    sessionId,
    pid: process.pid,
    acquiredAt: Date.now(),
  };

  try {
    if (existsSync(lockPath)) {
      // 检查持有者是否存活
      let existing: LockContent | null = null;
      try {
        existing = JSON.parse(readFileSync(lockPath, "utf-8"));
      } catch {
        existing = null;
      }

      // 自己已持有 → 幂等成功
      if (existing && existing.sessionId === sessionId) {
        return true;
      }

      // 持有者存活 → 抢锁失败
      if (existing && isProcessAlive(existing.pid)) {
        return false;
      }

      // 持有者已死或锁损坏 → 回收
      try {
        unlinkSync(lockPath);
      } catch {
        return false; // 删除失败，保守放弃
      }
    }

    // wx：原子性独占创建，已存在则抛错
    writeFileSync(lockPath, JSON.stringify(content), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** 释放调度器锁（仅当自己持有时） */
export function releaseSchedulerLock(dir: string, sessionId: string): void {
  const lockPath = join(dir, LOCK_FILE);
  try {
    if (!existsSync(lockPath)) return;
    const existing: LockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (existing.sessionId === sessionId) {
      unlinkSync(lockPath);
    }
  } catch {
    /* 忽略 */
  }
}
