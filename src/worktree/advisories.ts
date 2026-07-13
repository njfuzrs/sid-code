/**
 * Worktree 创建期告警（creation-time advisories）
 *
 * 定位：把「静默出错」变成「显式提示」，但不替用户做决定（对齐 CC「不猜、交给用户」哲学）。
 * 两类告警，均**只在条件真实成立时**触发，lockfile 一致 / 无 DB 时零输出（无噪音）。
 *
 * 1. 依赖一致性（比 CC 更进一步）
 *    - CC：默认不碰 node_modules，也不给任何依赖一致性提示。
 *    - sid-code：默认 symlink node_modules 到主仓（免装依赖、省磁盘），代价是
 *      当分支 lockfile 与主仓不同时，symlink 进来的是**主仓的依赖版本**而非本分支该有的版本，
 *      引发静默的 "module not found" / 版本错乱。这里做 lockfile hash 比对，
 *      不一致时告警——不自动跑 install（避免 install 的一堆边界 + 破坏现有行为），
 *      只把风险显式告诉用户，由用户决定是否手动重装。
 *
 * 2. 数据库 migration 提醒
 *    - 并行 worktree 共享同一数据库时 migration 可能互相打架（Cole Medin 称"静默杀手"）。
 *    - 检测到 migration 标记文件时追加一句提醒，纯字符串、零副作用。
 *
 * 设计约束：任何异常都吞掉（best-effort），绝不因告警逻辑阻断 worktree 创建。
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** 主流 JS 包管理器的 lockfile（顺序即优先级） */
const LOCKFILES = [
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
] as const;

/** 读取 lockfile 内容 hash（不存在返回 null） */
function lockfileHash(dir: string, file: string): string | null {
  try {
    const p = join(dir, file);
    if (!existsSync(p)) return null;
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 依赖一致性检查。
 *
 * 仅在「node_modules 被 symlink 到主仓」时才有意义——因为此时 worktree 用的是主仓依赖，
 * 若两边 lockfile 不同就会版本错乱。未 symlink（用户改了 symlinkDirectories 或 symlink 失败）
 * 则各自独立，无此问题，直接跳过。
 *
 * @param worktreePath worktree 根
 * @param gitRoot 主仓根
 * @param symlinkedNodeModules 本次是否确实 symlink 了 node_modules
 * @returns 告警字符串（无风险返回 null）
 */
export function checkDependencyConsistency(
  worktreePath: string,
  gitRoot: string,
  symlinkedNodeModules: boolean,
): string | null {
  // 没 symlink node_modules → 依赖各自独立 → 无版本错乱风险
  if (!symlinkedNodeModules) return null;

  for (const file of LOCKFILES) {
    const mainHash = lockfileHash(gitRoot, file);
    const wtHash = lockfileHash(worktreePath, file);
    // 只有两边都有同名 lockfile 才能比对；缺一（如 sparse-checkout 没检出）跳过该文件
    if (mainHash === null || wtHash === null) continue;
    if (mainHash !== wtHash) {
      return (
        `依赖不一致：${file} 与主仓不同，但 node_modules 是 symlink 到主仓的。\n` +
        `   worktree 里跑的将是**主仓的依赖版本**，可能导致 module not found / 版本错乱。\n` +
        `   建议：在此 worktree 内重装依赖（如 pnpm/bun/npm install），或删除 node_modules 软链后独立安装。`
      );
    }
    // 找到一个可比对的 lockfile 且一致 → 无需再看其它
    return null;
  }
  return null;
}

/**
 * 检测项目是否使用数据库 migration。
 * 命中即返回标记路径，用于向用户提示并行 worktree 的 DB 冲突风险。
 */
const DB_MIGRATION_MARKERS = [
  "prisma/schema.prisma",
  "prisma/migrations",
  "drizzle.config.ts",
  "drizzle.config.js",
  "knexfile.js",
  "knexfile.ts",
  "alembic.ini",
  "migrations", // Django / 通用 migrations 目录（放最后，避免误命中更精确的路径）
] as const;

/**
 * 数据库 migration 提醒。
 * @returns 告警字符串（未检测到 DB 返回 null）
 */
export function checkDatabaseUsage(worktreePath: string): string | null {
  let hit: string | null = null;
  for (const marker of DB_MIGRATION_MARKERS) {
    try {
      if (existsSync(join(worktreePath, marker))) {
        hit = marker;
        break;
      }
    } catch {
      /* 忽略单个 marker 的 stat 异常 */
    }
  }
  if (!hit) return null;
  return (
    `检测到数据库 migration（${hit}）。\n` +
    `   并行 worktree 共享同一数据库时，migration 可能互相冲突（table already exists / schema 覆盖）。\n` +
    `   建议：为本 worktree 指向独立 DB（改 DATABASE_URL），或用 Neon/PlanetScale 等 DB 分支。`
  );
}
