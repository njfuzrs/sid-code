/**
 * 只读 git 的「仓库身份」判定（B4）
 *
 * 只读放行过去只看「命令是不是只读」，不看「这是谁的仓库」：
 * `cd <恶意目录> && git status` 能借目录里的 git 配置与钩子执行代码，所以 `cd` 被判非只读；
 * 但裸 `git status` 在任意目录下都放行，于是「先在 acceptEdits 下用 write/mkdir 造出一个
 * 裸仓库形态目录（`HEAD` + `objects/` + `refs/` + 带 `core.fsmonitor` 的 `config`），
 * 再在那个目录里跑 git」就能零确认执行任意命令。
 *
 * 本模块回答一个问题：**这个目录里的 git 操作，作用在谁的仓库上？**
 * 判定只做 `stat` 和读一个小文件，不起子进程、不调 git。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 一个目录的 git 仓库归属 */
export type GitRepoTrust =
  /** 本仓：workspace 所在仓库，或它的 linked worktree（公共 git 目录相同） */
  | "own"
  /** 别的仓库：嵌套的独立仓库、workspace 外任何目录里的仓库 */
  | "foreign"
  /** 裸仓库形态：`HEAD` 文件 + `objects/` + `refs/`，没有 `.git` */
  | "bare"
  /** 不在任何仓库里（git 会直接报错，不危险，但也没有放行的理由） */
  | "none";

/** 判定结果的进程内缓存。key 含「本仓公共目录」，因为同一目录在不同 workspace 下结论不同 */
const trustCache = new Map<string, GitRepoTrust>();

/** 供测试与「会话内目录结构变了」的场景清空缓存 */
export function resetGitRepoTrustCache(): void {
  trustCache.clear();
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function readTrimmedOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * `.git` **文件**的第一行 `gitdir: <path>`（linked worktree / submodule 的形态）。
 * 路径按 `.git` 文件所在目录解析。
 */
function parseGitdirFile(content: string): string | null {
  const m = /^gitdir:[ \t]*(.+)$/m.exec(content);
  if (!m) return null;
  const raw = m[1]!.trim();
  return raw.length > 0 ? raw : null;
}

/**
 * 裸仓库形态判定：`HEAD` 是文件，且 `objects/`、`refs/` 是目录。
 *
 * 这是上游 CC `readOnlyValidation.ts` 对裸仓库的定义，也是 B4 那条攻击链上唯一的拦截点：
 * 这三个名字都能用普通 `write` / `mkdir` 造出来，而嵌套的 `.git/` 已被 safetyCheck 挡住。
 */
function isBareRepoShape(dir: string): boolean {
  if (!statOrNull(path.join(dir, "HEAD"))?.isFile()) return false;
  if (!statOrNull(path.join(dir, "objects"))?.isDirectory()) return false;
  if (!statOrNull(path.join(dir, "refs"))?.isDirectory()) return false;
  return true;
}

type RepoLocation = { kind: "repo"; commonDir: string } | { kind: "bare" };

/**
 * 从 `startDir` 向上逐级找 git 仓库。
 *
 * 每层先看 `.git`（目录 → 普通仓库；文件 → linked worktree，按 `commondir` 解析到公共 git 目录），
 * 再看裸仓库形态。**顺序不能反**：裸仓库形态的目录往往就在本仓内部（`<ws>/vendor/x`），
 * 先向上找到 `<ws>/.git` 会把它误判成本仓。
 */
function locateRepo(startDir: string): RepoLocation | null {
  let cur = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(cur, ".git");
    const dotGitStat = statOrNull(dotGit);
    if (dotGitStat?.isDirectory()) {
      const commonDir = realpathOrNull(dotGit);
      if (commonDir) return { kind: "repo", commonDir };
    } else if (dotGitStat?.isFile()) {
      const gitdirRaw = parseGitdirFile(readTrimmedOrNull(dotGit) ?? "");
      if (gitdirRaw) {
        const gitdirAbs = realpathOrNull(path.resolve(cur, gitdirRaw));
        if (gitdirAbs) {
          // linked worktree 的 `<gitdir>/commondir` 指向主仓的 `.git`（相对 gitdir 解析）。
          // 主仓自身没有这个文件，此时 gitdir 就是公共 git 目录。
          const commonRaw = readTrimmedOrNull(path.join(gitdirAbs, "commondir"));
          const commonDir = commonRaw
            ? realpathOrNull(path.resolve(gitdirAbs, commonRaw))
            : gitdirAbs;
          if (commonDir) return { kind: "repo", commonDir };
        }
      }
      // `.git` 是文件但读不出 gitdir：损坏或非常规布局，不当作任何仓库
    }

    if (isBareRepoShape(cur)) return { kind: "bare" };

    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * 算出一个目录所属仓库的**公共 git 目录**（主仓的 `.git`；linked worktree 解析到同一个）。
 *
 * 会话启动时对主工作目录算一次，作为「本仓」的基准。工作目录不在仓库里（或是裸仓库）时
 * 返回 `null` —— 此时所有只读 git 都会落到确认，这是安全方向上的退化，不会误放行。
 */
export function resolveOwnCommonDir(workspaceDir: string): string | null {
  const located = locateRepo(workspaceDir);
  return located?.kind === "repo" ? located.commonDir : null;
}

/**
 * 判定 `dir` 里的 git 操作作用在谁的仓库上。
 *
 * @param dir 命令实际运行的目录（绝对路径；调用方已解析 `-C` / `cd`）
 * @param ownCommonDir 本仓的公共 git 目录（{@link resolveOwnCommonDir}），`null` 表示本仓不可知
 */
export function resolveGitRepoTrust(dir: string, ownCommonDir: string | null): GitRepoTrust {
  const abs = realpathOrNull(dir) ?? path.resolve(dir);
  const cacheKey = `${ownCommonDir ?? "\u0000"}\u0001${abs}`;
  const cached = trustCache.get(cacheKey);
  if (cached) return cached;

  const located = locateRepo(abs);
  let trust: GitRepoTrust;
  if (!located) {
    trust = "none";
  } else if (located.kind === "bare") {
    trust = "bare";
  } else if (ownCommonDir && located.commonDir === ownCommonDir) {
    trust = "own";
  } else {
    trust = "foreign";
  }

  trustCache.set(cacheKey, trust);
  return trust;
}
