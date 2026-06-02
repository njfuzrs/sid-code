/**
 * 过期 Worktree 清理（Spec 18 §3.4.4）
 *
 * 只清理临时模式（agent-xxxx / swarm-xxxx）的 worktree；
 * 用户命名（词汇 slug）的永不自动清理。
 * 默认 30 天过期，且有未提交修改 / 未合并 commit 的一律不碰（fail-closed）。
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { WorktreeManager } from "./manager.ts";
import { getLogger } from "../debug/logger.ts";

/** 临时 Worktree 的命名模式（只清理这些） */
const EPHEMERAL_PATTERNS = [
  /^agent-[0-9a-f]{8}$/, // 子代理隔离
  /^agent-[a-z0-9]{8}$/, // 子代理（task id 形态）
  /^swarm-.+$/, // Swarm teammate
];

/** 判断目录名是否为临时 worktree */
export function isEphemeralWorktree(dirName: string): boolean {
  return EPHEMERAL_PATTERNS.some((p) => p.test(dirName));
}

/** 清理过期的临时 Worktree（默认 30 天） */
export async function cleanupStaleWorktrees(
  gitRoot: string,
  cutoffDays: number = 30,
): Promise<number> {
  const log = getLogger();
  const worktreeDir = join(gitRoot, ".sid-code", "worktrees");
  if (!existsSync(worktreeDir)) return 0;

  const cutoffMs = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
  const manager = new WorktreeManager(gitRoot);
  let removed = 0;

  let entries: string[] = [];
  try {
    entries = readdirSync(worktreeDir);
  } catch {
    return 0;
  }

  for (const dir of entries) {
    // 只清理临时模式的 worktree（用户命名的永不碰）
    if (!isEphemeralWorktree(dir)) continue;

    const fullPath = join(worktreeDir, dir);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }

    // 30 天内不碰
    if (mtimeMs >= cutoffMs) continue;

    // 有未提交修改或未推送 commit 不碰（fail-closed：null 也跳过）
    const changes = manager.countChanges(fullPath, "");
    if (changes === null || changes.changedFiles > 0 || changes.commits > 0) {
      continue;
    }

    try {
      await manager.remove(
        {
          originalCwd: gitRoot,
          worktreePath: fullPath,
          worktreeName: dir,
          sessionId: "",
          worktreeBranch: `worktree-${dir}`,
          originalHeadCommit: "",
        },
        true,
      );
      removed++;
    } catch (err: any) {
      log.debug("WORKTREE", `清理 ${dir} 失败: ${err.message}`);
    }
  }

  // 清理 Git 内部孤立条目
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
  return removed;
}
