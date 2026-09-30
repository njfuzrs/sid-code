/**
 * 过期 Worktree 清理（Spec 18 §3.4.4）
 *
 * 只清理临时模式（agent / swarm / wf / bridge / job）的 worktree；
 * 用户命名（词汇 slug）的永不自动清理。
 * 默认 30 天过期，且有未提交修改 / 未合并 commit / 被 git 锁定的一律不碰（fail-closed）。
 */

import { existsSync, readdirSync, statSync, lstatSync, readFileSync } from "fs";
import { join, resolve, sep } from "path";
import { execFileSync } from "child_process";
import { WorktreeManager, parseSidLockPid } from "./manager.ts";
import { isProcessAlive, listActiveSessions } from "../session/concurrent.ts";
import { branchNameForSlug } from "./slug.ts";
import { logWorktreeEvent } from "./analytics.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * W8：GC 删 worktree 时该顺手删的分支。只有「实际检出的分支 == 我们按目录名建的那条」
 * 才返回它，否则返回空串（remove() 见空串不删任何分支）。
 *
 * 旧实现直接 `branchNameForSlug(dir)`，从不问 worktree 实际检出了什么：
 * - 用户手动 `git worktree add .sid-code/worktrees/agent-xxx feature-login`
 *   → 去删一条不存在的 `worktree-agent-xxx`，而且
 * - 仓库里若恰好有一条同名分支（上次同名 worktree 残留）但目录检出的是别的，
 *   `branch -D` 会把那条无关分支强删，静默成功。
 * 实际分支是用户自己的（feature-login）时也不删：GC 只负责收我们自己造的东西。
 */
function ownedBranchToDelete(worktreePath: string, dir: string): string {
  try {
    const actual = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const expected = branchNameForSlug(dir);
    if (actual === expected) return expected;
    getLogger().debug(
      "WORKTREE",
      `GC ${dir}：检出的是 ${actual === "HEAD" ? "detached HEAD" : actual}，不是 ${expected}，不删分支`,
    );
  } catch {
    /* 读不到 → 不删任何分支（fail-closed） */
  }
  return "";
}

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
 * 检查 worktree 是否被 git 锁定（B9 / W13）。
 * git worktree lock 会在 .git/worktrees/<name>/locked 留标记。
 *
 * W13：以前全仓没有任何地方写这个标记，这道保护恒为 false。现在 manager.create /
 * restoreExisting 会以 `sid-code:pid=<pid>` 为理由加锁，所以这里要分三种：
 * - 理由是 sid-code 的、持有者 pid 还活着 → 锁定（另一个进程正在用）；
 * - 理由是 sid-code 的、持有者已死 → **不算**锁定：那是崩溃留下的陈旧锁，
 *   若照样当锁，崩溃遗留的孤儿就永远收不回来（remove() 会先解锁再删）；
 * - 其它理由（用户手动 `git worktree lock`）→ 锁定，尊重人的显式决定。
 */
function isWorktreeLocked(gitRoot: string, dirName: string): boolean {
  const reason = readLockedMarker(gitRoot, dirName);
  if (reason === null) return false;
  const pid = parseSidLockPid(reason);
  if (pid === null) return true;
  return isProcessAlive(pid);
}

/** 读 locked 标记内容；不存在返回 null。 */
function readLockedMarker(gitRoot: string, dirName: string): string | null {
  const candidates: string[] = [join(gitRoot, ".git", "worktrees", dirName, "locked")];
  // 也读 worktree 内 .git pointer 指向的 git dir 下的 locked（gitdir 名可能与目录名不同）
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
        candidates.push(join(absGitDir, "locked"));
      }
    }
  } catch {
    /* 忽略 */
  }
  for (const marker of candidates) {
    try {
      if (existsSync(marker)) return readFileSync(marker, "utf-8");
    } catch {
      /* 读不到内容但文件在 → 按用户锁处理（fail-closed） */
      return "";
    }
  }
  return null;
}

/**
 * W14：其它还活着的 sid-code 会话正站在哪些目录里。
 *
 * 旧实现只跳过本进程的一条 skipPath，另一个终端里正在跑长任务的 worktree
 * 对 GC 不可见。活跃会话注册表（~/.sid-code 下的 active sessions）本来就在，
 * persistence.ts 判「要不要自动 chdir」时已经在用它；删目录这件更不可逆的事反而没查。
 * 读失败时返回 null：调用方据此放弃本轮清理（fail-closed），而不是当成「没人在用」。
 */
function liveSessionCwds(): string[] | null {
  try {
    return listActiveSessions()
      .filter((e) => e.kind === "teammate" || isProcessAlive(e.pid))
      .map((e) => e.cwd)
      .filter((c): c is string => typeof c === "string" && c.length > 0)
      .map((c) => resolve(c));
  } catch {
    return null;
  }
}

function isUsedByLiveSession(fullPath: string, cwds: string[]): boolean {
  const root = resolve(fullPath);
  return cwds.some((c) => c === root || c.startsWith(root + sep));
}

/**
 * W23：worktree 的「最近一次被使用」时间，取几路信号的最大值。
 *
 * 旧实现只看目录本身的 mtime，而目录 mtime 只在目录项增删时更新 —— 改一个已有文件的
 * 内容不动它（APFS 实测）。于是一个连续几小时只改已有文件的隔离子代理，年龄停在
 * 创建那一刻，6 小时宽限一到就放行；改完就 commit 的代理工作区又是干净的，
 * countChanges 也拦不住，最后删掉的是一个还活着的 worktree 和它刚 commit 的分支。
 *
 * 现在额外看：
 * - worktree 自己 gitdir 下的 HEAD / index / logs/HEAD：commit、checkout、add 都会更新；
 * - `git status` 报出的每个改动 / 未追踪路径自身的 mtime：还没 add 的编辑也算活动。
 * 任何一路读不到就跳过那一路；目录 mtime 始终是下限，不会比旧实现更早判定过期。
 */
export function lastActivityMs(worktreePath: string): number {
  let latest = statSync(worktreePath).mtimeMs; // 读不到目录 → 抛出，由调用方跳过
  const bump = (p: string) => {
    try {
      const m = statSync(p).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* 该路信号不存在 */
    }
  };
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    for (const f of ["HEAD", "index", join("logs", "HEAD")]) bump(join(gitDir, f));
  } catch {
    /* 不是 git 工作区：只剩目录 mtime */
  }
  try {
    const out = execFileSync("git", ["status", "--porcelain", "-z", "-unormal"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const entries = out.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      const p = join(worktreePath, e.slice(3));
      // 与 countRealChanges 同口径：本进程 symlink 进来的 node_modules 等不算用户活动，
      // statSync 会跟随链接读到主仓目录的 mtime，把每个带 symlink 的孤儿都判成「刚用过」。
      try {
        if (lstatSync(p).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      bump(p);
      // 重命名 / 复制条目后面紧跟一个原路径字段，跳过它
      if (e[0] === "R" || e[0] === "C") i++;
    }
  } catch {
    /* status 失败：后面的 countChanges 会返回 null 并跳过这个 worktree */
  }
  return latest;
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

  // W14：进入循环前取一次活跃会话快照。读不到就整轮不删 —— 不能把「没查到」当「没人在用」。
  const liveCwds = liveSessionCwds();
  if (liveCwds === null) {
    log.debug("WORKTREE", "读不到活跃会话注册表，本轮跳过 worktree GC");
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
      mtimeMs = lastActivityMs(fullPath);
    } catch {
      continue;
    }

    // 年龄门槛未到则不碰。年龄 = 最近一次活动（W23，见 lastActivityMs），不是目录 mtime。
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

    // W14：别的活会话正站在这个 worktree（或它的子目录）里
    if (isUsedByLiveSession(fullPath, liveCwds)) {
      log.debug("WORKTREE", `worktree ${dir} 正被其它活跃会话使用，跳过清理`);
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
          worktreeBranch: ownedBranchToDelete(fullPath, dir),
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
