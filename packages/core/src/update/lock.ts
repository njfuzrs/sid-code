/**
 * 自动更新 — mkdir 锁 + stale 回收
 *
 * 锁机制：
 * - 抢锁 = `mkdirSync(lock/)`（mkdir 在 POSIX 上原子，EEXIST 即失败）
 * - 抢锁失败 → 读 `meta.json`，`startedAt` 距今 >30min 判 stale → 删锁重抢一次
 * - 释放 = 子进程收尾时 `rm -rf lock/`（写在子进程脚本里）
 *
 * ⚠️ 多实例同时启动：只有抢到锁的 spawn 安装，其余静默跳过
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getSidHome } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

const log = () => getLogger();

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 分钟

interface LockMeta {
  pid: number;
  startedAt: string; // ISO timestamp
  host: string;
}

/**
 * 锁句柄（负责释放）
 */
export interface LockHandle {
  lockDir: string;
  release: () => void;
}

/**
 * 获取锁目录路径
 */
function getLockDir(): string {
  return join(getSidHome(), "updates", "lock");
}

/**
 * 获取 meta 文件路径
 */
function getMetaPath(lockDir: string): string {
  return join(lockDir, "meta.json");
}

/**
 * 尝试获取锁
 * @returns LockHandle 如果成功，null 如果失败（已被其他实例持有）
 */
export function acquireLock(): LockHandle | null {
  const lockDir = getLockDir();

  // 第一次尝试
  try {
    mkdirSync(lockDir);
    // 成功 = 抢到锁，写 meta
    const meta: LockMeta = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: require("node:os").hostname(),
    };
    writeFileSync(getMetaPath(lockDir), JSON.stringify(meta, null, 2), { mode: 0o600 });
    return {
      lockDir,
      release: () => {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch (err) {
          log().warn("AUTO_UPDATE", `释放锁失败: ${err}`);
        }
      },
    };
  } catch (err: any) {
    if (err.code !== "EEXIST") {
      log().error("AUTO_UPDATE", `创建锁目录失败: ${err}`);
      return null;
    }
    // EEXIST = 锁已被持有，检查是否 stale
  }

  // 第二次尝试：检查 stale
  const metaPath = getMetaPath(lockDir);
  if (!existsSync(metaPath)) {
    // meta 文件缺失（可能 mkdir 成功但 writeFileSync 失败），视为 stale
    log().warn("AUTO_UPDATE", "锁目录存在但 meta.json 缺失，视为 stale，尝试重抢");
    try {
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
      const meta: LockMeta = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: require("node:os").hostname(),
      };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
      return {
        lockDir,
        release: () => {
          try {
            rmSync(lockDir, { recursive: true, force: true });
          } catch (err) {
            log().warn("AUTO_UPDATE", `释放锁失败: ${err}`);
          }
        },
      };
    } catch (err) {
      log().error("AUTO_UPDATE", `重抢锁失败: ${err}`);
      return null;
    }
  }

  // 读 meta，判断 stale
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const meta: LockMeta = JSON.parse(raw);
    const startedAt = new Date(meta.startedAt);
    if (isNaN(startedAt.getTime())) {
      log().warn("AUTO_UPDATE", `锁 meta.startedAt 非法: ${meta.startedAt}，视为 stale`);
    } else {
      const age = Date.now() - startedAt.getTime();
      if (age < STALE_THRESHOLD_MS) {
        log().info(
          "AUTO_UPDATE",
          `锁已被持有（pid=${meta.pid}, age=${Math.round(age / 1000)}s），跳过本次检查`,
        );
        return null;
      }
      log().warn(
        "AUTO_UPDATE",
        `锁 stale（pid=${meta.pid}, age=${Math.round(age / 1000)}s > 30min），尝试重抢`,
      );
    }
  } catch (err) {
    log().warn("AUTO_UPDATE", `读取锁 meta 失败，视为 stale: ${err}`);
  }

  // stale，删除重抢
  try {
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    const meta: LockMeta = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: require("node:os").hostname(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
    return {
      lockDir,
      release: () => {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch (err) {
          log().warn("AUTO_UPDATE", `释放锁失败: ${err}`);
        }
      },
    };
  } catch (err) {
    log().error("AUTO_UPDATE", `重抢锁失败: ${err}`);
    return null;
  }
}
