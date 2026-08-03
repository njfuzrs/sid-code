/**
 * 过期 Worktree 清理（Spec 18 §3.4.4）
 *
 * 只清理临时模式（agent / swarm / wf / bridge / job）的 worktree；
 * 用户命名（词汇 slug）的永不自动清理。
 * 默认 30 天过期，且有未提交修改 / 未合并 commit / 被 git 锁定的一律不碰（fail-closed）。
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { WorktreeManager } from "./manager.ts";
import { branchNameForSlug } from "./slug.ts";
import { logWorktreeEvent } from "./analytics.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * 临时 Worktree 的命名模式（只清理这些，P1-8 / B3）。
 * 覆盖四种来源：
 * - agent-xxxx        子代理隔离（hex / task id）
 * - swarm-...         Swarm teammate
 * - wf_<runId>-<idx>-<hex> / wf-<n>  Workflow（含 legacy）
 * - bridge-<id>       未来远程控制模式（P2-5 预留）
 * - job-<id>          守护进程 job 模式（预留）
 */
const EPHEMERAL_PATTERNS = [
  /^agent-[0-9a-f]{8}$/, // 子代理隔离
  /^agent-[a-z0-9]{8}$/, // 子代理（task id 形态）
  /^swarm-.+$/, // Swarm teammate
  /^wf_.+-\d+-[0-9a-f]{3,4}$/, // Workflow（wf_<runId>-<idx>-<hex>）
  /^wf-\d+$/, // Workflow（legacy）
  /^bridge-.+$/, // Bridge multi-session（P2-5）
  /^job-.+$/, // 守护进程 job 模式
];

/** 判断目录名是否为临时 worktree */
export function isEphemeralWorktree(dirName: string): boolean {
  return EPHEMERAL_PATTERNS.some((p) => p.test(dirName));
}

/**
 * 临时 worktree 的宽限期（6 小时）。
 *
 * 取值理由：临时 worktree 正常寿命是分钟级，6h 远超任何单次子代理任务，
 * 足以避开"另一进程正在跑长任务"的误判；同时又远短于 30 天，让崩溃遗留的
 * 孤儿在下次启动时就被回收而不是占盘一个月。
 * 仍受锁检查 / 改动检查 / 活跃 session 三重保护，不会误删有工作的目录。
 */
export const EPHEMERAL_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * 检查 worktree 是否被 git 锁定（B9）。
 * git worktree lock 会在 .git/worktrees/<name>/locked 留标记；
 * 锁定通常意味着另一进程正在使用，不应清理。
 */
function isWorktreeLocked(gitRoot: string, dirName: string): boolean {
  try {
    // 主仓 .git/worktrees/<name>/locked
    const lockedMarker = join(gitRoot, ".git", "worktrees", dirName, "locked");
    if (existsSync(lockedMarker)) return true;
  } catch {
    /* 忽略 */
  }
  // 也读 worktree 内 .git pointer 指向的 git dir 下的 locked
  try {
    const gitPointer = join(gitRoot, ".sid-code", "worktrees", dirName, ".git");
    if (existsSync(gitPointer)) {
      const content = readFileSync(gitPointer, "utf-8").trim();
      const m = content.match(/^gitdir:\s*(.+)$/);
      if (m) {
        const gitDir = m[1].trim();
        const absGitDir = gitDir.startsWith("/")
          ? gitDir
          : join(gitRoot, ".sid-code", "worktrees", dirName, gitDir);
        if (existsSync(join(absGitDir, "locked"))) return true;
      }
    }
  } catch {
    /* 忽略 */
  }
  return false;
}

/**
 * 清理过期的临时 Worktree（默认 30 天）。
 *
 * @param gitRoot 主仓根
 * @param cutoffDays 过期天数
 * @param skipPath 跳过的 worktree 路径（当前活跃 session，D16）
 */
export async function cleanupStaleWorktrees(
  gitRoot: string,
  cutoffDays: number = 30,
  skipPath?: string,
): Promise<number> {
  const log = getLogger();
  const worktreeDir = join(gitRoot, ".sid-code", "worktrees");
  if (!existsSync(worktreeDir)) return 0;

  const cutoffMs = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
  const manager = new WorktreeManager(gitRoot);
  let removed = 0;
  let skipped = 0;

  let entries: string[] = [];
  try {
    entries = readdirSync(worktreeDir);
  } catch {
    return 0;
  }

  for (const dir of entries) {
    // 只清理临时模式的 worktree（用户命名的永不碰）
    if (!isEphemeralWorktree(dir)) {
      skipped++;
      continue;
    }

    const fullPath = join(worktreeDir, dir);

    // D16：跳过当前活跃 session 的 worktree
    if (skipPath && fullPath === skipPath) {
      skipped++;
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }

    // 年龄门槛未到则不碰。
    //
    // 为什么临时 worktree 用比 cutoffDays 短得多的阈值（2026-08-02）：
    // 子代理 / workflow 的 worktree 正常寿命是**分钟级**，任务结束即由
    // agent/tool.ts 的 isolationCleanup 删除。能活到启动期还在的，基本都是
    // 上次进程崩溃 / 被 kill 留下的孤儿。让它们再多占 30 天磁盘（每个几十 MB，
    // 隔离子代理跑得频繁时轻松堆到几百 MB）没有任何收益。
    // EPHEMERAL_GRACE_MS 给足"另一进程刚创建、正在用"的余量，配合下方
    // 锁检查 + 改动检查 + 活跃 session skipPath，三重保护后才动手。
    const ageCutoff = Math.max(cutoffMs, Date.now() - EPHEMERAL_GRACE_MS);
    if (mtimeMs >= ageCutoff) {
      skipped++;
      continue;
    }

    // B9：被 git 锁定的不碰（另一进程可能在用）
    if (isWorktreeLocked(gitRoot, dir)) {
      log.debug("WORKTREE", `worktree ${dir} 被锁定，跳过清理`);
      skipped++;
      continue;
    }

    // 有未提交修改或未推送 commit 不碰（D16/D17；fail-closed：countChanges 返回 null 也跳过）。
    // ⚠ 这里曾写「fast 模式：-uno」——已过期且方向相反：fast 模式 2026-08-02 起
    // 改用 -unormal，**会**扫 untracked。旧的 -uno 让未 git add 的新文件对 GC 不可见，
    // 判定「无改动」后直接删掉 worktree，用户工作永久丢失。见 manager.countChanges 的注释。
    const changes = manager.countChanges(fullPath, "", { fast: true });
    if (changes === null || changes.changedFiles > 0 || changes.commits > 0) {
      skipped++;
      continue;
    }

    try {
      await manager.remove(
        {
          originalCwd: gitRoot,
          worktreePath: fullPath,
          worktreeName: dir,
          sessionId: "",
          worktreeBranch: branchNameForSlug(dir),
          originalHeadCommit: "",
        },
        true,
      );
      removed++;
    } catch (err: any) {
      log.debug("WORKTREE", `清理 ${dir} 失败: ${err.message}`);
    }
  }

  // P1-10：清理 Git 内部孤立条目
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: gitRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    /* 忽略 */
  }

  if (removed > 0) {
    log.info("WORKTREE", `清理了 ${removed} 个过期临时 Worktree`);
  }
  logWorktreeEvent("worktree_cleanup", { removedCount: removed, skippedCount: skipped });
  return removed;
}
