/**
 * 补传的跨进程退避与终态（U4，PR-C）。
 *
 * ## 要堵的洞
 *
 * 上传一直失败（502 / 超时）时 `.uploaded` 永远写不上，于是**每次启动都把同一份 445MB
 * 从头再来一遍**：读入、压缩、上传、失败。失败没有任何跨进程记忆，也没有终态。
 *
 * ## 两个文件，都在会话目录里
 *
 * - `.upload-attempts`：`{attempts, lastAttemptMs, lastError}`。补传扫描据此做指数退避，
 *   没到期的会话本轮不碰（计入 `backoff`，不并进 pending）。
 * - `.upload-failed`：终态。累计失败 {@link MAX_AUTO_ATTEMPTS} 次后写入，之后**不再自动重试**，
 *   只能 `--upload-traces` 手动处理。
 *
 * ## 为什么终态必须可见
 *
 * P0 防线「补传绝不能悄悄丢」（collector.ts 启动补传那段注释）：进了终态的会话要在
 * `/debug` 与 `--upload-traces` 的输出里单列出来。手动命令无视退避与终态（用户显式要传），
 * 成功后清掉两个文件。
 *
 * 判据只看会话目录自己的文件，与 `.uploaded` 同一种「只依赖磁盘现状」的口径（backfill.ts 头注释）。
 */

import { existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPLOAD_ATTEMPTS_FILE = ".upload-attempts";
export const UPLOAD_FAILED_FILE = ".upload-failed";

/**
 * 自动补传的最大累计失败次数。退避序列 1h·2^(n-1) 封顶 48h：
 * 1+2+4+8+16+32+48 ≈ 111h，第 8 次失败约在首次失败后 4.6 天——一周内给够机会，
 * 又不至于让一个注定失败的大文件每天吃掉一次上行带宽。
 */
export const MAX_AUTO_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60 * 60 * 1000;
const BACKOFF_CAP_MS = 48 * 60 * 60 * 1000;

export interface UploadAttempts {
  attempts: number;
  lastAttemptMs: number;
  lastError: string;
}

export interface UploadFailedMarker {
  failed_at: string;
  attempts: number;
  reason: string;
}

/**
 * 在会话目录里增删记账文件时**保持目录 mtime 不变**。
 *
 * 目录 mtime 是好几处判据的输入：补传的「太新不动」时间闸与最旧优先排序、轨迹淘汰的 LRU、
 * 空壳清理的静置时长。记一次失败就把它刷成「现在」，等于让一个上传失败的老会话在淘汰里
 * 被当成新会话保护起来、在补传里被时间闸挡住（单测抓到的：手动重传刚失败的会话被判 tooNew）。
 * 记账是旁路信息，不该改变这些判据。
 */
export function preservingDirMtime<T>(dir: string, fn: () => T): T {
  let atime: Date | undefined;
  let mtime: Date | undefined;
  try {
    const st = statSync(dir);
    atime = st.atime;
    mtime = st.mtime;
  } catch {
    /* 目录不存在：fn 自己会失败 */
  }
  try {
    return fn();
  } finally {
    if (atime && mtime) {
      try {
        utimesSync(dir, atime, mtime);
      } catch {
        /* 恢复失败只影响时间判据，不影响数据 */
      }
    }
  }
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readUploadAttempts(sessionDir: string): UploadAttempts | null {
  const a = readJson<UploadAttempts>(join(sessionDir, UPLOAD_ATTEMPTS_FILE));
  if (!a || typeof a.attempts !== "number" || typeof a.lastAttemptMs !== "number") return null;
  return a;
}

export function readUploadFailed(sessionDir: string): UploadFailedMarker | null {
  const p = join(sessionDir, UPLOAD_FAILED_FILE);
  if (!existsSync(p)) return null;
  // 文件存在即终态；内容读不出也按终态处理（宁可少传一次，不批量重来）
  return readJson<UploadFailedMarker>(p) ?? { failed_at: "", attempts: 0, reason: "unknown" };
}

/** 第 n 次失败之后要等多久才能再试（n ≥ 1） */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

/** 是否仍在退避窗口内（true = 本轮跳过） */
export function isInBackoff(sessionDir: string, now: number = Date.now()): boolean {
  const a = readUploadAttempts(sessionDir);
  if (!a) return false;
  return now - a.lastAttemptMs < backoffMs(a.attempts);
}

/**
 * 记一次失败。累计达到上限时写终态并返回 true。
 * 写失败只意味着下次启动会再试一次——方向是多传不是少传。
 */
export function recordUploadFailure(
  sessionDir: string,
  error: string,
  now: number = Date.now(),
): boolean {
  const prev = readUploadAttempts(sessionDir);
  const next: UploadAttempts = {
    attempts: (prev?.attempts ?? 0) + 1,
    lastAttemptMs: now,
    lastError: error.slice(0, 500),
  };
  try {
    preservingDirMtime(sessionDir, () =>
      writeFileSync(join(sessionDir, UPLOAD_ATTEMPTS_FILE), JSON.stringify(next)),
    );
    if (next.attempts >= MAX_AUTO_ATTEMPTS) {
      const marker: UploadFailedMarker = {
        failed_at: new Date(now).toISOString(),
        attempts: next.attempts,
        reason: next.lastError,
      };
      preservingDirMtime(sessionDir, () =>
        writeFileSync(join(sessionDir, UPLOAD_FAILED_FILE), JSON.stringify(marker)),
      );
      return true;
    }
  } catch {
    /* 见函数注释 */
  }
  return false;
}

/** 上传成功（或手动重传成功）后清掉退避与终态 */
export function clearUploadAttempts(sessionDir: string): void {
  for (const f of [UPLOAD_ATTEMPTS_FILE, UPLOAD_FAILED_FILE]) {
    try {
      const p = join(sessionDir, f);
      if (existsSync(p)) preservingDirMtime(sessionDir, () => unlinkSync(p));
    } catch {
      /* 残留的退避文件最坏让下次自动补传晚一点，不丢数据 */
    }
  }
}
