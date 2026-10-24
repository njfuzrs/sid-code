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
import { basename, dirname, join, normalize } from "path";

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

/** 一组 lockfile 比对结果：命中第一份两边都有的 lockfile 即定论（一致 null / 不一致文件名） */
function compareLockfilesIn(
  worktreeDir: string,
  mainDir: string,
): { decided: false } | { decided: true; mismatch: string | null } {
  for (const file of LOCKFILES) {
    const mainHash = lockfileHash(mainDir, file);
    const wtHash = lockfileHash(worktreeDir, file);
    // 只有两边都有同名 lockfile 才能比对；缺一（如 sparse-checkout 没检出）跳过该文件
    if (mainHash === null || wtHash === null) continue;
    return { decided: true, mismatch: mainHash !== wtHash ? file : null };
  }
  return { decided: false };
}

/**
 * 依赖一致性检查。
 *
 * 仅对「被 symlink 到主仓的 node_modules 目录」有意义——此时 worktree 用的是主仓依赖，
 * 若两边 lockfile 不同就会版本错乱。未 symlink 的目录各自独立，无此问题。
 *
 * 旧实现只认顶层的 `"node_modules"`：monorepo 用户在 symlinkDirectories 里配
 * `packages/app/node_modules` 时这条告警整个不生效。现在对每个 basename 为 `node_modules`
 * 的链接目录，从它的父目录（包级 lockfile）逐级向上找到仓库根（workspace 根 lockfile），
 * 取第一层两边都有 lockfile 的目录比对 —— 与包管理器自己找 lockfile 的方向一致。
 *
 * @param worktreePath worktree 根
 * @param gitRoot 主仓根
 * @param symlinkedDirs 本次确实建成 symlink 的目录（相对仓库根，来自 symlinkDirectories）
 * @returns 告警字符串（无风险返回 null）
 */
export function checkDependencyConsistency(
  worktreePath: string,
  gitRoot: string,
  symlinkedDirs: readonly string[],
): string | null {
  const mismatches: string[] = [];
  const seen = new Set<string>();
  for (const dir of symlinkedDirs) {
    const rel = normalize(dir).replace(/[\\/]+$/, "");
    if (basename(rel) !== "node_modules") continue;
    // 从链接所在包目录逐级向上（含仓库根），第一层可比对的 lockfile 即定论
    let pkg = dirname(rel);
    for (;;) {
      if (!seen.has(pkg)) {
        seen.add(pkg);
        const r = compareLockfilesIn(join(worktreePath, pkg), join(gitRoot, pkg));
        if (r.decided) {
          if (r.mismatch) mismatches.push(pkg === "." ? r.mismatch : join(pkg, r.mismatch));
          break;
        }
      } else break; // 这一层（及其上层）已被别的链接目录判过
      if (pkg === "." || pkg === "") break;
      pkg = dirname(pkg);
    }
  }
  if (mismatches.length === 0) return null;
  return (
    `依赖不一致：${mismatches.join("、")} 与主仓不同，但对应的 node_modules 是 symlink 到主仓的。\n` +
    `   worktree 里跑的将是**主仓的依赖版本**，可能导致 module not found / 版本错乱。\n` +
    `   建议：在此 worktree 内重装依赖（如 pnpm/bun/npm install），或删除 node_modules 软链后独立安装。`
  );
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
