/**
 * 启动期配置目录"管家"任务（P1-2 + P2-1）
 *
 * 集中四件启动期幂等维护工作，均为 fire-and-forget、失败不阻塞启动：
 * 1. ensureConfigGitignore() —— 生成配置目录自身的 .gitignore（见 ensure-gitignore.ts）
 * 2. cleanupLegacyToolResults() —— 清理修复前老代码遗留的 tool-results 污染目录
 * 3. ensureRuntimeFilesGitignored() —— 把项目 .sid-code/ 下的运行时文件注册进全局 gitignore
 * 4. 按"清理水位线"节流触发过期数据清理 —— 避免每次启动都扫全盘
 *
 * 项目 .sid-code/ 的 gitignore 策略（对标 claude-code，详见 lock.ts 文件头注）：
 * ┌────────────────────────────┬──────────┬────────────────────────────────┐
 * │ 文件                       │ 类型     │ Gitignore                       │
 * ├────────────────────────────┼──────────┼────────────────────────────────┤
 * │ scheduled_tasks.lock       │ 运行时锁 │ ✅ 全局 gitignore（本次修复）  │
 * │ settings.local.json        │ 本地配置 │ ✅ 写入时 fire-and-forget      │
 * │ permissions.local.yaml     │ 本地配置 │ ⬜ 读取不写入，暂不处理        │
 * │ scheduled_tasks.json       │ 团队配置 │ ❌ 不忽略（允许团队共享提交）  │
 * │ settings.json              │ 团队配置 │ ❌ 不忽略（允许团队共享提交）  │
 * │ commands/ skills/ agents/  │ 用户创建 │ ❌ 不忽略（用户显式初始化）    │
 * └────────────────────────────┴──────────┴────────────────────────────────┘
 *
 * 清理水位线机制（对标定期 GC）：
 * - 在 ~/.sid-code/.last-cleanup 记录上次清理的时间戳
 * - 距上次清理不足 CLEANUP_INTERVAL_MS（默认 24h）则跳过，零开销
 * - 到期则跑一轮轻量清理：删除明显过期的运行时数据目录的 stale 条目，
 *   随后刷新水位线
 *
 * 注意：本模块不做激进删除——只清理"明确过期且可安全重建"的运行时数据
 *（trajectories 旧 session、tmp、旧 tool-results）。settings/记忆/检查点等由各自模块按策略管理。
 */

import { existsSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "./paths.ts";
import { ensureConfigGitignore } from "./ensure-gitignore.ts";
import { addFileGlobRuleToGitignore } from "./gitignore.ts";

/** 清理触发间隔：24 小时 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** trajectories 内 session 目录的过期阈值：30 天 */
const TRAJECTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 需要在全局 gitignore 中隐藏的运行时文件（非配置、非用户创建） */
const RUNTIME_FILES_TO_GITIGNORE = [
  ".sid-code/scheduled_tasks.lock",
];

/**
 * 执行启动期管家任务。应在 loadConfig 之后、主循环之前调用一次。
 * @param now 当前时间戳（ms）。显式传入便于测试；默认 Date.now()。
 */
export function runStartupHousekeeping(now: number = Date.now()): void {
  // 1. 配置目录 .gitignore（独立幂等，与清理无关，始终尝试）
  ensureConfigGitignore();

  // 2. 一次性清理修复前老代码遗留的 tool-results 目录
  //    背景：早期 result-storage.ts 使用裸相对路径 ".sid-code/tool-results"，
  //    会在 cwd 下创建污染目录。修复后路径已改为 ~/.sid-code/trajectories/…，
  //    但修复前跑出的旧目录不会自动消失。此处做幂等清理：检测到即删。
  try {
    cleanupLegacyToolResults();
  } catch (err) {
    getLogger().debug("CLEANUP", `旧 tool-results 清理跳过: ${err}`);
  }

  // 3. 注册项目 .sid-code/ 下的运行时文件到全局 gitignore
  //    对标 claude-code 的 addFileGlobRuleToGitignore 机制，确保
  //    scheduled_tasks.lock 等纯运行时文件在所有项目中自动被 git 忽略，
  //    用户不会在 git status 里看到它们（fire-and-forget，不阻塞启动）。
  try {
    ensureRuntimeFilesGitignored();
  } catch (err) {
    getLogger().debug("CLEANUP", `运行时文件 gitignore 注册跳过: ${err}`);
  }

  // 4. 按水位线节流的过期清理
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

/**
 * 一次性清理修复前老代码遗留的 .sid-code/tool-results/ 污染目录。
 *
 * 背景（详见 docs/bugfixes/double_checked/点sid-code目录污染项目git工作区-路径策略不一致分析.md）：
 * 早期 result-storage.ts 使用裸相对路径 ".sid-code/tool-results"，会在用户当前
 * 所在的任意项目目录下创建 .sid-code/tool-results/ 目录。修复（2026-06-11）已将
 * 落盘路径改为 ~/.sid-code/trajectories/sessions/{sessionId}/tool-outputs/，但修复前
 * 跑出的旧目录不会自动消失。
 *
 * 本函数在启动时检测当前 cwd 下是否存在 .sid-code/tool-results/ 目录，
 * 存在则递归删除。幂等：不存在则无操作。fire-and-forget：失败不阻塞启动。
 */
function cleanupLegacyToolResults(): void {
  const legacyDir = join(process.cwd(), ".sid-code", "tool-results");
  if (!existsSync(legacyDir)) return;

  const log = getLogger();
  try {
    rmSync(legacyDir, { recursive: true, force: true });
    log.info("CLEANUP", `已清理旧 tool-results 目录: ${legacyDir}`);
  } catch (err: any) {
    log.debug("CLEANUP", `清理旧 tool-results 目录失败: ${err?.message ?? err}`);
  }
}

/**
 * 将项目 .sid-code/ 下的运行时文件注册到全局 gitignore。
 *
 * 设计对标 claude-code：只操作全局 gitignore（~/.config/git/ignore），
 * 不修改项目自己的 .gitignore。写入前用 git check-ignore 判重，
 * 非 git 仓库直接跳过。fire-and-forget，不阻塞启动。
 *
 * 适用范围：纯运行时文件（scheduled_tasks.lock）。
 * 不包含：团队可共享配置（scheduled_tasks.json / settings.json）、
 * 用户显式创建的目录（commands/ skills/ agents/）。
 */
function ensureRuntimeFilesGitignored(): void {
  for (const file of RUNTIME_FILES_TO_GITIGNORE) {
    void addFileGlobRuleToGitignore(file);
  }
}
