/**
 * 守护进程单例锁（缺口 C1 §3.3）
 *
 * 同一机器同一配置只允许跑一个 sid-code daemon。锁文件放配置目录（state/），
 * 因为守护进程是「本机全局」的（管多个项目的任务），不是项目级。
 *
 * ⚠️ 这与 cron/lock.ts 的「项目级」scheduled_tasks.lock 是两把不同的锁：
 *   - 项目级 scheduled_tasks.lock：同项目多个交互会话只让一个驱动持久任务
 *   - 本机级 daemon.lock（本文件）：同机器只跑一个守护进程
 *
 * 复用 concurrent.ts 的 PID 探活模式回收崩溃残留的锁（stale）。
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { sidPaths } from "../config/paths.ts";
import { getVersion } from "@sid-code/shared/version.ts";

export interface DaemonLockContent {
  pid: number;
  startedAt: number;
  version: string;
}

function lockPath(): string {
  return sidPaths.stateFile("daemon.lock");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM 表示进程存在但无权限发信号（仍算存活）
    return err?.code === "EPERM";
  }
}

/** 读取当前锁内容（不存在或损坏返回 null） */
export function readDaemonLock(): DaemonLockContent | null {
  const path = lockPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DaemonLockContent;
  } catch {
    return null;
  }
}

/**
 * 检查是否已有存活的守护进程。
 * 顺带回收 stale 锁（持有者已死）。
 * 供交互式会话判断「daemon 在场 → 放弃 durable 驱动」（C1-Lock-B）。
 */
export function isDaemonRunning(): boolean {
  const existing = readDaemonLock();
  if (!existing) return false;
  if (isProcessAlive(existing.pid)) return true;
  // stale：回收
  try {
    unlinkSync(lockPath());
  } catch {
    /* 忽略 */
  }
  return false;
}

/**
 * 尝试获取守护进程单例锁。
 * 成功返回 true；已有存活守护进程返回 false（拒绝启动第二个）。
 */
export function tryAcquireDaemonLock(): boolean {
  const path = lockPath();
  const content: DaemonLockContent = {
    pid: process.pid,
    startedAt: Date.now(),
    version: safeVersion(),
  };

  try {
    mkdirSync(dirname(path), { recursive: true });

    if (existsSync(path)) {
      const existing = readDaemonLock();
      // 持有者存活 → 抢锁失败（已有守护进程）
      if (existing && isProcessAlive(existing.pid)) {
        return false;
      }
      // 持有者已死或锁损坏 → 回收
      try {
        unlinkSync(path);
      } catch {
        return false; // 删除失败，保守放弃
      }
    }

    // wx：原子性独占创建，已存在则抛错
    writeFileSync(path, JSON.stringify(content, null, 2), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** 释放守护进程锁（仅当自己持有时） */
export function releaseDaemonLock(): void {
  const path = lockPath();
  try {
    if (!existsSync(path)) return;
    const existing = readDaemonLock();
    if (existing && existing.pid === process.pid) {
      unlinkSync(path);
    }
  } catch {
    /* 忽略 */
  }
}

function safeVersion(): string {
  try {
    return getVersion();
  } catch {
    return "unknown";
  }
}
