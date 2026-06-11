/**
 * 启动期配置目录"管家"任务（P1-2 + P2-1）
 *
 * 集中两件启动期幂等维护工作，均为 fire-and-forget、失败不阻塞启动：
 * 1. ensureConfigGitignore() —— 生成配置目录自身的 .gitignore（见 ensure-gitignore.ts）
 * 2. 按"清理水位线"节流触发过期数据清理 —— 避免每次启动都扫全盘
 *
 * 清理水位线机制（对标定期 GC）：
 * - 在 ~/.sid-code/.last-cleanup 记录上次清理的时间戳
 * - 距上次清理不足 CLEANUP_INTERVAL_MS（默认 24h）则跳过，零开销
 * - 到期则跑一轮轻量清理：删除明显过期的运行时数据目录的 stale 条目，
 *   随后刷新水位线
 *
 * 注意：本模块不做激进删除——只清理"明确过期且可安全重建"的运行时数据
 *（trajectories 旧 session、tmp）。settings/记忆/检查点等由各自模块按策略管理。
 */

import { existsSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "./paths.ts";
import { ensureConfigGitignore } from "./ensure-gitignore.ts";

/** 清理触发间隔：24 小时 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** trajectories 内 session 目录的过期阈值：30 天 */
const TRAJECTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 执行启动期管家任务。应在 loadConfig 之后、主循环之前调用一次。
 * @param now 当前时间戳（ms）。显式传入便于测试；默认 Date.now()。
 */
export function runStartupHousekeeping(now: number = Date.now()): void {
  // 1. 配置目录 .gitignore（独立幂等，与清理无关，始终尝试）
  ensureConfigGitignore();

  // 2. 按水位线节流的过期清理
  try {
    if (!shouldRunCleanup(now)) return;
    const removed = cleanupStaleTrajectories(now);
    writeWatermark(now);
    if (removed > 0) {
      getLogger().info("CLEANUP", `启动清理：移除 ${removed} 个过期 trajectory 会话目录`);
    }
  } catch (err) {
    getLogger().debug("CLEANUP", `启动清理跳过: ${err}`);
  }
}

/** 距上次清理是否已超过间隔（水位线不存在视为需要清理） */
function shouldRunCleanup(now: number): boolean {
  try {
    const path = sidPaths.lastCleanup();
    if (!existsSync(path)) return true;
    const last = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (!Number.isFinite(last)) return true;
    return now - last >= CLEANUP_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** 刷新清理水位线为当前时间 */
function writeWatermark(now: number): void {
  try {
    writeFileSync(sidPaths.lastCleanup(), String(now), { mode: 0o644 });
  } catch {
    // 写水位线失败不致命：最坏下次启动再尝试清理
  }
}

/**
 * 清理 trajectories/sessions 下超过 TRAJECTORY_MAX_AGE_MS 的会话目录。
 * 返回移除的目录数。
 */
function cleanupStaleTrajectories(now: number): number {
  const sessionsRoot = join(sidPaths.trajectories(), "sessions");
  if (!existsSync(sessionsRoot)) return 0;

  let removed = 0;
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessionsRoot, entry.name);
    try {
      const stat = statSync(dir);
      if (now - stat.mtimeMs > TRAJECTORY_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // 单个目录失败不影响其它
    }
  }
  return removed;
}
