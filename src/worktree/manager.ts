/**
 * Worktree 隔离系统核心管理器（Spec 18 §3）
 *
 * Git Worktree 共享主仓库 `.git` 对象库，创建速度毫秒级，磁盘开销只有工作区文件大小。
 * 用于多代理并行、并行实验、多方案对比等需要文件系统隔离的场景。
 *
 * 设计要点：
 * - Fail-Closed：Git 命令失败时 countChanges 返回 null，调用方拒绝删除
 * - Post-Creation Setup：symlink 可配置目录、复制 settings.local、配置共享 hooks、.worktreeinclude
 * - 扁平化 slug：避免 Git D/F（目录/文件）冲突
 * - Hook-based VCS：非 git 仓库可经 WorktreeCreate/Remove hook 接管
 * - Canonical root：穿透 worktree pointer 定位主仓根，防嵌套
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  chmodSync,
} from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import type {
  WorktreeSession,
  WorktreeChanges,
  CreateWorktreeOptions,
} from "./types.ts";
import {
  validateWorktreeSlug,
  flattenSlug,
  branchNameForSlug,
} from "./slug.ts";
import { findCanonicalGitRoot } from "./canonical.ts";
import { getWorktreeConfig } from "./config.ts";
import {
  hasWorktreeCreateHook,
  hasWorktreeRemoveHook,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
} from "./hooks.ts";
import { applyWorktreeInclude } from "./include-copy.ts";

// re-export 类型（向后兼容旧 import 路径）
export type { WorktreeSession, WorktreeChanges } from "./types.ts";

/** git worktree remove 后等待 git 释放锁的时间（ms，P2-9） */
const GIT_LOCK_WAIT_MS = 100;

/**
 * 查找包含给定目录的 Git 仓库根。
 * 非 Git 环境返回 null。
 */
export function findGitRoot(fromDir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: fromDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** 解析仓库默认分支（origin/HEAD → main/master 兜底） */
function resolveDefaultBranch(gitRoot: string): string {
  try {
    const ref = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    // refs/remotes/origin/main → main
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {
    /* 无 origin/HEAD */
  }
  // 兜底：检查本地是否有 main / master
  for (const b of ["main", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", b], {
        cwd: gitRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return b;
    } catch {
      /* 继续 */
    }
  }
  return "main";
}

export class WorktreeManager {
  private readonly worktreeDir: string;

  constructor(private gitRoot: string) {
    this.worktreeDir = join(gitRoot, ".sid-code", "worktrees");
  }

  /** Worktree 根目录 */
  getWorktreeDir(): string {
    return this.worktreeDir;
  }

  /**
   * 创建 Worktree。
   *
   * @param slug worktree 名称（会校验 + 扁平化）
   * @param opts prNumber（fetch PR 分支）/ baseRef（基准 ref 覆盖）
   */
  async create(
    slug: string,
    opts: CreateWorktreeOptions = {},
  ): Promise<WorktreeSession> {
    const startedAt = Date.now();

    // B5/P0-4：任何 fs/git 操作前先校验 slug
    const validation = validateWorktreeSlug(slug);
    if (!validation.valid) {
      throw new Error(`非法 worktree 名称: ${validation.error}`);
    }

    const flatSlug = flattenSlug(slug);
    const worktreePath = join(this.worktreeDir, flatSlug);
    const branchName = branchNameForSlug(flatSlug);

    // P2-8：快速恢复——worktree 已存在则直接复用（读 .git pointer，不 spawn git）
    if (existsSync(join(worktreePath, ".git"))) {
      return this.restoreExisting(worktreePath, flatSlug, branchName);
    }

    mkdirSync(this.worktreeDir, { recursive: true });

    // P1-1：Hook-based VCS 优先（非 git 仓库走 hook）
    if (hasWorktreeCreateHook(this.gitRoot)) {
      return this.createViaHook(slug, flatSlug, branchName, startedAt);
    }

    const originalBranch = this.getCurrentBranch();
    const headCommit = this.getHeadCommit();

    // 解析基准 ref（P1-3 PR / P2-3 baseRef）
    const baseTreeIsh = this.resolveBaseTreeish(opts, branchName, worktreePath);

    // 创建 worktree（-B 强制重建分支，避免残留分支冲突，D4）
    execFileSync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, baseTreeIsh],
      { cwd: this.gitRoot, stdio: ["pipe", "pipe", "pipe"] },
    );

    // P2-2：sparse-checkout（失败回滚整个 worktree）
    const cfg = getWorktreeConfig(this.gitRoot);
    let usedSparsePaths = false;
    if (cfg.sparsePaths.length > 0) {
      try {
        this.applySparseCheckout(worktreePath, cfg.sparsePaths);
        usedSparsePaths = true;
      } catch (err: any) {
        // D6：回滚整个 worktree
        getLogger().warn("WORKTREE", `sparse-checkout 失败，回滚 worktree: ${err.message}`);
        try {
          execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
            cwd: this.gitRoot,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
        }
        throw err;
      }
    }

    await this.postCreationSetup(worktreePath);

    return {
      originalCwd: this.gitRoot,
      worktreePath,
      worktreeName: flatSlug,
      sessionId: opts.sessionId ?? "",
      worktreeBranch: branchName,
      originalBranch,
      originalHeadCommit: headCommit,
      usedSparsePaths,
      creationDurationMs: Date.now() - startedAt,
    };
  }

  /** 经 WorktreeCreate hook 创建（P1-1，非 git VCS） */
  private async createViaHook(
    slug: string,
    flatSlug: string,
    branchName: string,
    startedAt: number,
  ): Promise<WorktreeSession> {
    const { worktreePath } = await executeWorktreeCreateHook(slug, this.gitRoot);
    return {
      originalCwd: this.gitRoot,
      worktreePath,
      worktreeName: flatSlug,
      sessionId: "",
      worktreeBranch: branchName,
      originalBranch: this.getCurrentBranch(),
      originalHeadCommit: this.getHeadCommit(),
      hookBased: true,
      creationDurationMs: Date.now() - startedAt,
    };
  }

  /**
   * 解析 worktree add 的基准 tree-ish。
   * 优先级：PR fetch > opts.baseRef > settings.baseRef(fresh/head)。
   * 失败一律 fallback 到 HEAD（带日志）。
   */
  private resolveBaseTreeish(
    opts: CreateWorktreeOptions,
    branchName: string,
    _worktreePath: string,
  ): string {
    const log = getLogger();

    // P1-3：PR fetch
    if (opts.prNumber !== undefined) {
      const prRef = `pull/${opts.prNumber}/head`;
      try {
        execFileSync(
          "git",
          ["fetch", "origin", `${prRef}:${branchName}`],
          { cwd: this.gitRoot, stdio: ["pipe", "pipe", "pipe"] },
        );
        // fetch 已建好 branchName，worktree add -B 会复用之
        return branchName;
      } catch (err: any) {
        log.warn("WORKTREE", `PR #${opts.prNumber} fetch 失败，fallback HEAD: ${err.message}`);
        return "HEAD";
      }
    }

    // 显式 baseRef（opts 覆盖 settings）
    const cfg = getWorktreeConfig(this.gitRoot);
    const baseRefMode = opts.baseRef ?? cfg.baseRef;

    if (baseRefMode === "head") {
      return "HEAD";
    }

    if (baseRefMode === "fresh") {
      // P2-3：从 origin/<default-branch> 创建（先本地，缺则 fetch，再缺 fallback HEAD）
      const defaultBranch = resolveDefaultBranch(this.gitRoot);
      const originRef = `origin/${defaultBranch}`;
      if (this.refExists(originRef)) {
        return originRef;
      }
      try {
        execFileSync("git", ["fetch", "origin", defaultBranch], {
          cwd: this.gitRoot,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (this.refExists(originRef)) return originRef;
      } catch {
        /* fetch 失败 */
      }
      log.debug("WORKTREE", `无法解析 ${originRef}，fallback HEAD`);
      return "HEAD";
    }

    // 自定义 baseRef 字符串（opts.baseRef 非 fresh/head）
    if (opts.baseRef && this.refExists(opts.baseRef)) {
      return opts.baseRef;
    }
    if (opts.baseRef) {
      try {
        execFileSync("git", ["fetch", "origin", opts.baseRef], {
          cwd: this.gitRoot,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (this.refExists(opts.baseRef)) return opts.baseRef;
      } catch {
        /* fetch 失败 */
      }
      log.warn("WORKTREE", `baseRef ${opts.baseRef} 不存在，fallback HEAD`);
    }
    return "HEAD";
  }

  /** ref 是否存在 */
  private refExists(ref: string): boolean {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: this.gitRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 应用 sparse-checkout（P2-2） */
  private applySparseCheckout(worktreePath: string, paths: string[]): void {
    execFileSync("git", ["-C", worktreePath, "sparse-checkout", "init", "--cone"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["-C", worktreePath, "sparse-checkout", "set", ...paths], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /**
   * 统计 Worktree 变更。
   * 返回 null 表示无法确定状态 —— 调用方必须视为"不安全"（fail-closed）。
   *
   * @param opts.fast 清理场景用 `-uno` 跳过 untracked 扫描（大仓性能优化，D16）；
   *                  并统计未推送 commit（HEAD --not --remotes，D17）而非仅相对 original HEAD。
   */
  countChanges(
    worktreePath: string,
    originalHeadCommit: string,
    opts: { fast?: boolean } = {},
  ): WorktreeChanges | null {
    try {
      // 未提交文件。fast 模式用 -uno 跳过 untracked 全量扫描（D16）
      const statusArgs = opts.fast
        ? ["status", "--porcelain", "-uno"]
        : ["status", "--porcelain"];
      const statusOutput = execFileSync("git", statusArgs, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const changedFiles = statusOutput ? statusOutput.split("\n").length : 0;

      let commits = 0;
      if (opts.fast) {
        // D17：未推送到任何 remote 的 commit（比相对 original HEAD 更准确地反映"会丢失的工作"）
        try {
          const out = execFileSync(
            "git",
            ["rev-list", "--count", "HEAD", "--not", "--remotes"],
            { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          ).trim();
          commits = parseInt(out, 10);
          if (Number.isNaN(commits)) commits = 0;
        } catch {
          // 无 remote 或命令失败 → fail-closed，视为有未推送 commit
          commits = changedFiles > 0 ? commits : 1;
        }
      } else if (originalHeadCommit) {
        // 相对原始 HEAD 的新 commit
        const out = execFileSync(
          "git",
          ["rev-list", "--count", `${originalHeadCommit}..HEAD`],
          { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
        commits = parseInt(out, 10);
        if (Number.isNaN(commits)) commits = 0;
      }

      return { changedFiles, commits };
    } catch {
      // Git 命令失败 → 返回 null（fail-closed）
      return null;
    }
  }

  /** 安全删除 Worktree */
  async remove(session: WorktreeSession, force: boolean = false): Promise<boolean> {
    if (!force) {
      const changes = this.countChanges(
        session.worktreePath,
        session.originalHeadCommit,
      );

      // Fail-closed：无法确定状态时拒绝删除
      if (changes === null) {
        throw new Error(
          "无法确定 Worktree 状态，拒绝删除。请使用 force 参数强制删除。",
        );
      }

      if (changes.changedFiles > 0 || changes.commits > 0) {
        throw new Error(
          `Worktree 有 ${changes.changedFiles} 个未提交文件和 ${changes.commits} 个未合并 commit。` +
            `删除将永久丢失这些工作。请使用 force 参数确认。`,
        );
      }
    }

    // P1-1：Hook 创建的 worktree 走 remove hook（git worktree 始终走 git，即使配了 hook）
    if (session.hookBased) {
      if (hasWorktreeRemoveHook(this.gitRoot)) {
        await executeWorktreeRemoveHook(session.worktreePath, this.gitRoot);
      }
      return true;
    }

    // 删除 worktree 目录
    try {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", session.worktreePath],
        { cwd: this.gitRoot, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      // git worktree remove 失败时手动清理目录
      if (existsSync(session.worktreePath)) {
        rmSync(session.worktreePath, { recursive: true, force: true });
      }
    }

    // P2-9：等待 git 释放 .git/worktrees/<name>/locked，防后续 branch -D 锁冲突
    await new Promise((resolve) => setTimeout(resolve, GIT_LOCK_WAIT_MS));

    // 删除临时分支
    try {
      execFileSync("git", ["branch", "-D", session.worktreeBranch], {
        cwd: this.gitRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // 分支可能已不存在，忽略
    }

    // 清理 Git 内部孤立条目
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: this.gitRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* 忽略 */
    }

    return true;
  }

  /** Post-creation setup：symlink 配置目录 + 复制 settings.local + 共享 hooks + commit归因 + include */
  private async postCreationSetup(worktreePath: string): Promise<void> {
    const log = getLogger();
    const cfg = getWorktreeConfig(this.gitRoot);

    // 1. symlink 可配置目录（P1-6，默认 node_modules）
    for (const dir of cfg.symlinkDirectories) {
      const src = join(this.gitRoot, dir);
      const dest = join(worktreePath, dir);
      // 防覆盖用户数据（D21）：仅当主仓有、worktree 无时才 symlink
      if (existsSync(src) && !existsSync(dest)) {
        try {
          symlinkSync(src, dest, "dir");
        } catch (err: any) {
          // B4：失败不阻断，但记录 warning
          log.warn("WORKTREE", `symlink ${dir} 失败（非关键）: ${err.message}`);
        }
      }
    }

    // 2. 配置 core.hooksPath（共享主仓库 hooks，幂等：已正确则跳过，D22）
    const hooksPath = join(this.gitRoot, ".git", "hooks");
    if (existsSync(hooksPath)) {
      try {
        let current = "";
        try {
          current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
            cwd: worktreePath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
        } catch {
          /* 未设置 */
        }
        if (current !== hooksPath) {
          execFileSync("git", ["config", "core.hooksPath", hooksPath], {
            cwd: worktreePath,
            stdio: ["pipe", "pipe", "pipe"],
          });
        }
      } catch {
        /* 非关键，忽略 */
      }
    }

    // 3. 复制 settings.local.json（P1-5）
    if (cfg.copyLocalSettings) {
      this.copyLocalSettings(worktreePath);
    }

    // 4. commit 归因 hook（P2-4，可选）
    if (cfg.commitAttribution) {
      this.installCommitAttributionHook(worktreePath);
    }

    // 5. .worktreeinclude 文件复制（P1-4）
    try {
      applyWorktreeInclude(this.gitRoot, worktreePath);
    } catch (err: any) {
      log.warn("WORKTREE", `.worktreeinclude 处理失败（非关键）: ${err.message}`);
    }
  }

  /** 复制主仓 .sid-code/settings.local.json 到 worktree（P1-5） */
  private copyLocalSettings(worktreePath: string): void {
    const log = getLogger();
    const src = join(this.gitRoot, ".sid-code", "settings.local.json");
    if (!existsSync(src)) return;
    const destDir = join(worktreePath, ".sid-code");
    const dest = join(destDir, "settings.local.json");
    if (existsSync(dest)) return; // 防覆盖
    try {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(src, dest);
      log.debug("WORKTREE", "已复制 settings.local.json 到 worktree");
    } catch (err: any) {
      log.warn("WORKTREE", `复制 settings.local.json 失败（非关键）: ${err.message}`);
    }
  }

  /** 安装 commit 归因 hook（P2-4） */
  private installCommitAttributionHook(worktreePath: string): void {
    const log = getLogger();
    const hookDir = join(worktreePath, ".git", "hooks");
    const hookPath = join(hookDir, "prepare-commit-msg");
    // 不覆盖已存在的 hook
    if (existsSync(hookPath)) return;
    // worktree 的 .git 是 pointer file，hooks 实际在主仓 worktrees/<name>/ 下，
    // 直接用 git rev-parse 找到该 worktree 的 git dir
    let gitDir = "";
    try {
      gitDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return;
    }
    const realHookDir = join(worktreePath, gitDir);
    const realHookPath = join(realHookDir, "prepare-commit-msg");
    if (existsSync(realHookPath)) return;
    const script = `#!/bin/sh
# sid-code commit 归因 hook（自动安装）
COMMIT_MSG_FILE="$1"
if ! grep -q "Co-Authored-By: sid-code" "$COMMIT_MSG_FILE" 2>/dev/null; then
  printf '\\nCo-Authored-By: sid-code <noreply@sid-code.dev>\\n' >> "$COMMIT_MSG_FILE"
fi
`;
    try {
      mkdirSync(realHookDir, { recursive: true });
      writeFileSync(realHookPath, script, "utf-8");
      chmodSync(realHookPath, 0o755);
      log.debug("WORKTREE", "已安装 commit 归因 hook");
    } catch (err: any) {
      log.warn("WORKTREE", `安装 commit 归因 hook 失败（非关键）: ${err.message}`);
    }
  }

  // ── 辅助方法 ──

  private getCurrentBranch(): string {
    try {
      // detached HEAD 时 git 返回 "HEAD"（B8）
      const result = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.gitRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return result || "HEAD";
    } catch {
      return "HEAD";
    }
  }

  private getHeadCommit(): string {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.gitRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return "";
    }
  }

  private restoreExisting(
    worktreePath: string,
    slug: string,
    branchName: string,
  ): WorktreeSession {
    let headCommit = "";
    try {
      headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      /* 忽略 */
    }

    return {
      originalCwd: this.gitRoot,
      worktreePath,
      worktreeName: slug,
      sessionId: "",
      worktreeBranch: branchName,
      originalHeadCommit: headCommit,
    };
  }
}

// ── 当前会话的 Worktree 状态（模块级单例） ──
// 注意：无 AsyncLocalStorage，主进程同一时间只在一个 worktree 中（嵌套被禁止）。

let currentSession: WorktreeSession | null = null;

/** 获取当前 Worktree 会话（不在 worktree 中返回 null） */
export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentSession;
}

/** 设置当前 Worktree 会话 */
export function setCurrentWorktreeSession(session: WorktreeSession | null): void {
  currentSession = session;
}

/** 清除当前 Worktree 会话 */
export function clearWorktreeSession(): void {
  currentSession = null;
}

/**
 * 清除依赖 CWD 的缓存。
 * 切换 worktree 后，系统提示词、git 状态等缓存基于旧 CWD，必须失效。
 */
export async function clearCwdDependentCaches(): Promise<void> {
  try {
    const { clearPromptCache } = await import("../config/system-prompt.ts");
    clearPromptCache();
  } catch {
    /* 忽略 */
  }
  try {
    const { clearGitStatusCache } = await import("../config/attachments.ts");
    clearGitStatusCache();
  } catch {
    /* 忽略 */
  }
}

/**
 * 为 ephemeral worktree 解析 canonical git root（防嵌套，P0-2/B1）。
 * agent / workflow / swarm 创建临时 worktree 时调用，确保新 worktree
 * 落在主仓 .sid-code/worktrees/ 下而非当前 worktree 内。
 *
 * 优先 findCanonicalGitRoot（穿透 pointer），失败回退 findGitRoot。
 */
export function findGitRootForAgent(fromDir: string): string | null {
  return findCanonicalGitRoot(fromDir) ?? findGitRoot(fromDir);
}
