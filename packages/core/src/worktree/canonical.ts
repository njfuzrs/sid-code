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
 * 主仓根的推导结果。null = 推不出来（调用方须回退问 git，别拿错路径当真）。
 */
function mainRootFromPointer(worktreeDir: string, absGitdir: string): string | null {
  // git 在每个 linked worktree 的 gitdir 里放一个 commondir，内容指向**共用的 git dir**
  // （普通布局是 "../.."）。这是 git 自己记录主仓位置的唯一途径，必须读它，
  // 不能靠"向上两级"硬算——那个层数只在 `<repo>/.git/worktrees/<name>` 这一种布局下成立。
  let commonRaw = "";
  try {
    commonRaw = readFileSync(join(absGitdir, "commondir"), "utf-8").trim();
  } catch {
    /* 没有 commondir，下面按"pointer 直指 git dir"处理 */
  }

  if (!commonRaw) {
    // 没有 commondir ⇒ 这不是 linked worktree 的 gitdir，而是 `git init --separate-git-dir`
    // 主 checkout 的 .git 指针：它直接指向仓库的 git dir 本体。
    // 此时 worktreeDir 自己就是仓库根（实测 `git rev-parse --show-toplevel` 同此）。
    try {
      if (statSync(join(absGitdir, "HEAD")).isFile()) return worktreeDir;
    } catch {
      /* 不是 git dir，推不出来 */
    }
    return null;
  }

  const commonDir = resolve(absGitdir, commonRaw);
  const candidate = dirname(commonDir);
  // 判据不是「候选根下有个 .git 目录」，而是「候选根的 .git **就是** commonDir 本身」。
  //
  // 弱判据（只验存在性）会被两种布局蒙过去，两种都实测过：
  // - `git init --separate-git-dir=<别处>`：commonDir 是那个"别处"，它的父目录跟仓库根
  //   毫无关系。原实现连这一层都没有（直接向上两级），把仓库根指到了仓库外面。
  // - 嵌套：外层恰好也是个 git 仓库时，`<候选>/.git` 存在且是目录——于是把**外层无关仓库**
  //   当成了这个 worktree 的主仓。这条是写本函数时真踩到的（测试里留了护栏）。
  // 身份相等才能把「这个目录的 .git」和「这个 worktree 共用的 git dir」对上。
  //
  // 对不上就返回 null：git 在**任何文件里都没有记录** separate-git-dir 的主 checkout
  // 路径（实测 grep 整个 git dir 零命中），所以那种布局下正确答案是「推不出来」，
  // 由 findGitRootForAgent 回退到 `git rev-parse --show-toplevel` 让 git 自己回答。
  // 编一个路径出来比承认不知道更糟——错的根会把 worktree 建到项目外、且 GC 扫不到。
  try {
    const candidateGit = join(candidate, ".git");
    if (statSync(candidateGit).isDirectory() && resolve(candidateGit) === resolve(commonDir)) {
      return candidate;
    }
  } catch {
    /* 候选根不是仓库根 */
  }
  return null;
}

/**
 * 定位真正的主仓 .git 目录所在的仓库根（非 worktree pointer）。
 *
 * 从 fromDir 向上遍历，对每层的 .git：
 * - 是目录 → 这就是主仓根，直接返回。
 * - 是文件（pointer file，内容 "gitdir: <path>"）→ 读 pointer 指向的 gitdir 里的
 *   `commondir` 定位共用 git dir，再取其父目录为主仓根；校验不过则返回 null
 *   （separate-git-dir 等布局下 git 没有记录主 checkout 路径，见 mainRootFromPointer）。
 *
 * 非 git 环境、或无法可靠推导时返回 null——调用方（findGitRootForAgent）会回退
 * 到 `git rev-parse --show-toplevel`。
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
        // worktree / separate-git-dir 的 .git pointer file
        const content = readFileSync(gitPath, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) {
          const gitdir = match[1].trim();
          // gitdir 可能是相对路径（相对 worktree 目录）或绝对路径
          const absGitdir = resolve(dir, gitdir);
          const mainRepoRoot = mainRootFromPointer(dir, absGitdir);
          if (mainRepoRoot) return mainRepoRoot;
          // 推不出主仓根：不再继续向上找。
          // 这里确实是一个 git 工作区（.git pointer 有效），继续向上只会撞到
          // 外层某个无关仓库（比如 /tmp 恰好在某个仓库里）并把它当主仓返回。
          return null;
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
 * W22：主会话工作区（进入 / 退出 worktree）切换后要跟着重载的东西。
 *
 * 权限规则的 project / local 两个来源按「工作区目录」读文件，而 checker 在 cli.ts 里
 * 建于 worktree 恢复**之前**，此后没有任何东西告诉它目录变了 —— worktree 里那份
 * settings.local.json 永远读不到。worktree 模块不 import permission（方向反了会成环），
 * 所以反过来由持有 checker 的一方（App）登记回调。
 */
type WorkspaceChangeListener = (newCwd: string) => void | Promise<void>;
const workspaceChangeListeners = new Set<WorkspaceChangeListener>();

/** 登记工作区切换回调，返回注销函数。 */
export function onWorkspaceChange(fn: WorkspaceChangeListener): () => void {
  workspaceChangeListeners.add(fn);
  return () => workspaceChangeListeners.delete(fn);
}

/** 通知所有登记方工作区已切到 newCwd。单个回调失败不影响其余回调，也不阻断切换本身。 */
export async function notifyWorkspaceChange(newCwd: string): Promise<void> {
  for (const fn of [...workspaceChangeListeners]) {
    try {
      await fn(newCwd);
    } catch (err: any) {
      const { getLogger } = await import("../debug/logger.ts");
      getLogger().warn("WORKTREE", `工作区切换回调失败: ${err?.message ?? err}`);
    }
  }
}

/**
 * 完整的 worktree 进入操作：切 cwd + 清依赖 cwd 的缓存 + 通知工作区切换（W22）。
 */
export async function enterWorktreeCwd(worktreePath: string): Promise<void> {
  switchCwd(worktreePath);
  const { clearCwdDependentCaches } = await import("./manager.ts");
  await clearCwdDependentCaches();
  await notifyWorkspaceChange(worktreePath);
}

/**
 * 完整的 worktree 退出操作：切回原 cwd + 清依赖 cwd 的缓存 + 通知工作区切换（W22）。
 */
export async function exitWorktreeCwd(originalCwd: string): Promise<void> {
  switchCwd(originalCwd);
  const { clearCwdDependentCaches } = await import("./manager.ts");
  await clearCwdDependentCaches();
  await notifyWorkspaceChange(originalCwd);
}
