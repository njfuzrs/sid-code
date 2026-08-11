/**
 * MCP OAuth token 刷新跨进程互斥锁
 *
 * 对标 Claude Code refreshAuthorization 中的 proper-lockfile 用法。sid-code 无
 * 该依赖，改用「原子 mkdir」实现跨进程锁——mkdir 在 POSIX/Windows 上都是原子的，
 * 同一目录只能被一个进程成功创建，天然适合做锁。
 *
 * 目的：多个 sid-code 实例同时发现 token 过期时，避免并发刷新——并发刷新会让
 * 先返回的那次刷新作废另一次的 refresh_token（很多授权服务器刷新即轮换）。
 */

import { mkdirSync, rmdirSync, existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { MCPServerConfig } from "../config/config.ts";
import { sidPaths } from "../config/paths.ts";
import { getServerKey } from "./oauth-storage.ts";
import { getLogger } from "../debug/logger.ts";

/** 获取锁的最大重试次数 */
const MAX_LOCK_RETRIES = 5;
/** 每次重试基础等待（ms），叠加随机抖动 */
const LOCK_RETRY_BASE_MS = 1000;
/** 锁过期时间（ms）：超过此时长视为陈旧锁（持有进程崩溃），可强夺 */
const LOCK_STALE_MS = 30_000;

function lockDir(serverName: string, config: MCPServerConfig): string {
  const key = getServerKey(serverName, config).replace(/[^a-zA-Z0-9]/g, "_");
  return join(sidPaths.mcpOAuthLocks(), `${key}.lock`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 确保锁根目录存在 */
function ensureLockRoot(): void {
  const root = sidPaths.mcpOAuthLocks();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
}

/** 尝试获取锁一次：原子 mkdir 成功即拿到；目录已存在且未陈旧则失败 */
function tryAcquire(dir: string): boolean {
  try {
    mkdirSync(dir);
    // 写入持有者信息（pid + 时间戳）用于陈旧判定
    try {
      writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    } catch {}
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // 锁已被占——检查是否陈旧
      if (isStale(dir)) {
        forceRelease(dir);
        // 陈旧锁已清，再试一次原子创建
        try {
          mkdirSync(dir);
          try {
            writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
          } catch {}
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    // 其它错误（权限等）当作拿不到锁
    return false;
  }
}

/** 判定锁是否陈旧（持有者超过 LOCK_STALE_MS 未释放，多半是进程崩溃） */
function isStale(dir: string): boolean {
  try {
    const ownerPath = join(dir, "owner");
    if (existsSync(ownerPath)) {
      const owner = JSON.parse(readFileSync(ownerPath, "utf-8")) as { pid: number; ts: number };
      return Date.now() - owner.ts > LOCK_STALE_MS;
    }
    // 无 owner 文件，用目录创建时间兜底
    const st = statSync(dir);
    return Date.now() - st.ctimeMs > LOCK_STALE_MS;
  } catch {
    // 读不到信息，保守视为陈旧（避免永久死锁）
    return true;
  }
}

/** 强制释放锁目录 */
function forceRelease(dir: string): void {
  try {
    const ownerPath = join(dir, "owner");
    if (existsSync(ownerPath)) {
      unlinkSync(ownerPath);
    }
    rmdirSync(dir);
  } catch {
    // 已被别的进程清掉，忽略
  }
}

/**
 * 在跨进程锁保护下执行 fn。
 * 拿不到锁时退避重试 MAX_LOCK_RETRIES 次；仍失败则放弃锁直接执行（best-effort，
 * 对标 CC「proceeding without lock」——宁可偶发并发刷新也不要卡死用户）。
 */
export async function withRefreshLock<T>(
  serverName: string,
  config: MCPServerConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const log = getLogger();
  ensureLockRoot();
  const dir = lockDir(serverName, config);

  let acquired = false;
  for (let retry = 0; retry < MAX_LOCK_RETRIES; retry++) {
    if (tryAcquire(dir)) {
      acquired = true;
      break;
    }
    log.debug("MCP", `${serverName} 刷新锁被占用，等待重试 (${retry + 1}/${MAX_LOCK_RETRIES})`);
    await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
  }

  if (!acquired) {
    log.warn("MCP", `${serverName} 获取刷新锁失败，无锁执行（best-effort）`);
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      forceRelease(dir);
    }
  }
}
