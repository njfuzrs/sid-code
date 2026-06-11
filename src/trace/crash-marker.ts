/**
 * Crash 快照标记模块
 *
 * 目标：无论进程以何种方式终止（SIGKILL、V8 OOM、segfault、uncaughtException），
 * 都能在磁盘上留下完整证据链，供下次启动自动诊断。
 *
 * 设计原则：
 * - write() 使用同步写入（fs.writeFileSync），确保在 V8 OOM 前有最后一搏的机会落盘
 * - 正常退出时 cleanup() 删除 crash.json（不残留）
 * - 启动时 readPrevious() 扫描残留 = 异常退出诊断
 * - 所有操作 try-catch，绝不抛异常（诊断模块不能成为新的故障点）
 *
 * 对标 claude-code：claude-code 无此模块（its ecosystem manage process lifecycle differently），
 * 此为 sid-code 独有创新——将 crashpad dump 转换为结构化 crash.json。
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { sidPaths } from "../config/paths.ts";

// ─── 类型定义 ───

/** Crash 快照数据结构 */
export interface CrashSnapshot {
  /** 会话 ID */
  session_id: string;
  /** 崩溃时间（ISO 8601） */
  timestamp: string;
  /** 错误消息 */
  error_message: string;
  /** 错误类型名称 */
  error_name: string;
  /** 错误堆栈（前 10 行） */
  stack?: string;
  /** 最后一次 API 调用的序号（从 BeforeModel 计数） */
  last_api_call_index: number;
  /** 最后一次 API 调用使用的模型 */
  last_model: string;
  /** 最后一次工具调用名称 */
  last_tool?: string;
  /** 最后一次 stop_reason */
  last_stop_reason?: string;
  /** 内存占用（MB，RSS） */
  memory_mb: number;
  /** 进程已运行时间（秒） */
  uptime_seconds: number;
  /** 终止信号（如 SIGTERM、SIGKILL） */
  signal?: string;
  /** 进程标题 */
  process_title?: string;
}

// ─── 路径常量 ───

/** 基础路径：~/.sid-code/trajectories/ */
function baseDir(): string {
  return sidPaths.trajectories();
}

/** 对应 session 目录下的 crash 文件 */
function crashPath(sessionId: string): string {
  return join(baseDir(), "sessions", sessionId, "crash.json");
}

/** 获取最后一层目录（提取 sessionId） */
function extractSessionId(pathStr: string): string {
  const parts = pathStr.replace(/\/$/, "").split("/");
  return parts[parts.length - 1];
}

/**
 * 扫描 trajectories/sessions/ 目录，查找有 crash.json 残留的会话。
 * 按文件修改时间升序返回（最早在先），只返回最近 10 个。
 */
function findCrashedSessions(): string[] {
  try {
    const sessionsDir = join(baseDir(), "sessions");
    if (!existsSync(sessionsDir)) return [];

    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    const crashed: Array<{ sessionId: string; mtime: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cp = crashPath(entry.name);
      if (existsSync(cp)) {
        const stat = statSync(cp);
        crashed.push({ sessionId: entry.name, mtime: stat.mtimeMs });
      }
    }

    // 按时间升序（最老的在前面）
    crashed.sort((a, b) => a.mtime - b.mtime);
    return crashed.slice(0, 10).map((c) => c.sessionId);
  } catch {
    return [];
  }
}

// ─── 公开 API ───

/**
 * 同步写入 crash.json 到磁盘。
 *
 * ⚠️ 使用同步写入（writeFileSync），因为调用方通常是 uncaughtException / V8 OOM 上下文，
 * 异步操作可能被事件循环裁剪。同步写是 OOM 前的最后一搏。
 */
export function write(snapshot: CrashSnapshot): boolean {
  try {
    const dir = join(baseDir(), "sessions", snapshot.session_id);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filePath = crashPath(snapshot.session_id);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    return true;
  } catch {
    // 静默失败：OOM 时文件系统可能已不可用
    return false;
  }
}

/**
 * 启动时扫描残留 crash.json，返回最近一个异常退出的快照。
 * 如果所有会话都正常退出（无 crash.json 残留），返回 null。
 */
export function readPrevious(): CrashSnapshot | null {
  try {
    const crashed = findCrashedSessions();
    if (crashed.length === 0) return null;

    // 取最新的（数组最后一个）
    const latestSessionId = crashed[crashed.length - 1];
    const filePath = crashPath(latestSessionId);

    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as CrashSnapshot;
  } catch {
    return null;
  }
}

/**
 * 正常退出时删除 crash.json。
 * 由 App 在 SIGINT/SIGTERM、/quit、runHeadless finally 中调用。
 */
export function cleanup(sessionId: string): void {
  try {
    const filePath = crashPath(sessionId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // 正常清理失败不是故障，无需告警
  }
}

/**
 * 清理所有残留 crash.json（历史遗留清理，批量操作）。
 * 通常由 `--cleanup-crash-markers` 命令触发。
 */
export function cleanupAll(): { cleaned: number; errors: number } {
  let cleaned = 0;
  let errors = 0;
  try {
    const crashed = findCrashedSessions();
    for (const sessionId of crashed) {
      try {
        cleanup(sessionId);
        cleaned++;
      } catch {
        errors++;
      }
    }
  } catch {
    // 静默
  }
  return { cleaned, errors };
}
