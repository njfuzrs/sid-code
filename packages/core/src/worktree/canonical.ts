/**
 * Canonical Git Root 定位 + CWD 原子切换（P0-2 / B1 / B2）
 *
 * 两个独立但相关的关注点：
 *
 * 1. findCanonicalGitRoot()：穿透 worktree 的 .git pointer file 追溯到主仓根。
 *    防嵌套（不变量 §8.2）：agent 在 worktree 内再建 worktree 时，新 worktree 必须
 *    落在主仓的 .sid-code/worktrees/ 下，而非当前 worktree 内，否则产生孤儿嵌套目录。
 *
 * 2. switchCwd()：process.chdir + setCwd 原子执行。防止二者不一致导致的状态漂移（B2）。
 */

import { statSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { setCwd } from "../bootstrap/state.ts";

/**
 * 定位真正的主仓 .git 目录所在的仓库根（非 worktree pointer）。
 *
 * 从 fromDir 向上遍历，对每层的 .git：
 * - 是目录 → 这就是主仓根，直接返回。
 * - 是文件（worktree pointer，内容 "gitdir: /path/to/main/.git/worktrees/<name>"）
 *   → 解析出主仓 .git 路径，向上两级得到主仓 .git，再向上一级得到仓库根。
 *
 * 非 git 环境返回 null。
 */
export function findCanonicalGitRoot(fromDir: string): string | null {
  let dir = resolve(fromDir);
  // 防御性上限：避免异常符号链接导致的无限循环
  for (let depth = 0; depth < 256; depth++) {
    const gitPath = join(dir, ".git");
    try {
      const stat = statSync(gitPath);
      if (stat.isDirectory()) {
        // 主仓的 .git 目录
        return dir;
      }
      if (stat.isFile()) {
        // worktree 的 .git pointer file
        const content = readFileSync(gitPath, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) {
          const gitdir = match[1].trim();
          // gitdir 可能是相对路径（相对 worktree 目录）或绝对路径
          const absGitdir = resolve(dir, gitdir);
          // .git/worktrees/<name> → 向上两级 = 主仓 .git
          const mainGitDir = resolve(absGitdir, "..", "..");
          const mainRepoRoot = resolve(mainGitDir, "..");
          try {
            if (statSync(mainGitDir).isDirectory()) {
              return mainRepoRoot;
            }
          } catch {
            /* mainGitDir 不存在，继续向上回退 */
          }
        }
      }
    } catch {
      // .git 不存在，继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // 到达文件系统根
    dir = parent;
  }
  return null;
}

/**
 * 原子切换工作目录：process.chdir + setCwd 同步执行（B2）。
 * 防止二者不一致导致路径类工具解析到错误目录。
 */
export function switchCwd(newPath: string): void {
  process.chdir(newPath);
  setCwd(newPath); // 同步全局 cwd 状态，使路径类工具 getCwd() 解析到新目录
}

/**
 * 完整的 worktree 进入操作：切 cwd + 清依赖 cwd 的缓存。
 */
export async function enterWorktreeCwd(worktreePath: string): Promise<void> {
  switchCwd(worktreePath);
  const { clearCwdDependentCaches } = await import("./manager.ts");
  await clearCwdDependentCaches();
}

/**
 * 完整的 worktree 退出操作：切回原 cwd + 清依赖 cwd 的缓存。
 */
export async function exitWorktreeCwd(originalCwd: string): Promise<void> {
  switchCwd(originalCwd);
  const { clearCwdDependentCaches } = await import("./manager.ts");
  await clearCwdDependentCaches();
}
