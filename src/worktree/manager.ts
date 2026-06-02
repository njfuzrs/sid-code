/**
 * Worktree 隔离系统核心管理器（Spec 18 §3）
 *
 * Git Worktree 共享主仓库 `.git` 对象库，创建速度毫秒级，磁盘开销只有工作区文件大小。
 * 用于多代理并行、并行实验、多方案对比等需要文件系统隔离的场景。
 *
 * 设计要点：
 * - Fail-Closed：Git 命令失败时 countChanges 返回 null，调用方拒绝删除
 * - Post-Creation Setup：符号链接 node_modules、配置共享 hooks
 * - 扁平化 slug：避免 Git D/F（目录/文件）冲突
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, symlinkSync, rmSync } from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";

/** Worktree 会话状态 */
export interface WorktreeSession {
  /** 原始工作目录（主仓库 gitRoot） */
  originalCwd: string;
  /** Worktree 路径 */
  worktreePath: string;
  /** Worktree 名称（扁平化 slug） */
  worktreeName: string;
  /** 会话 ID（由调用方填充） */
  sessionId: string;
  /** Worktree 分支名 */
  worktreeBranch: string;
  /** 原始分支名 */
  originalBranch?: string;
  /** 创建时的 HEAD commit */
  originalHeadCommit: string;
  /** 是否基于 Hook 创建 */
  hookBased?: boolean;
}

/** Worktree 变更统计 */
export interface WorktreeChanges {
  changedFiles: number;
  commits: number;
}

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

export class WorktreeManager {
  private readonly worktreeDir: string;

  constructor(private gitRoot: string) {
    this.worktreeDir = join(gitRoot, ".sid-code", "worktrees");
  }

  /** Worktree 根目录 */
  getWorktreeDir(): string {
    return this.worktreeDir;
  }

  /** 创建 Worktree */
  async create(slug: string): Promise<WorktreeSession> {
    const flatSlug = slug.replace(/\//g, "+"); // 扁平化，避免 Git D/F 冲突
    const worktreePath = join(this.worktreeDir, flatSlug);
    const branchName = `worktree-${flatSlug}`;

    // 快速恢复：worktree 已存在则直接复用
    if (existsSync(join(worktreePath, ".git"))) {
      return this.restoreExisting(worktreePath, flatSlug, branchName);
    }

    mkdirSync(this.worktreeDir, { recursive: true });

    const originalBranch = this.getCurrentBranch();
    const headCommit = this.getHeadCommit();

    // 创建 worktree（-B 强制重建分支，避免残留分支冲突）
    execFileSync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, "HEAD"],
      { cwd: this.gitRoot, stdio: ["pipe", "pipe", "pipe"] },
    );

    await this.postCreationSetup(worktreePath);

    return {
      originalCwd: this.gitRoot,
      worktreePath,
      worktreeName: flatSlug,
      sessionId: "",
      worktreeBranch: branchName,
      originalBranch,
      originalHeadCommit: headCommit,
    };
  }

  /**
   * 统计 Worktree 变更。
   * 返回 null 表示无法确定状态 —— 调用方必须视为"不安全"（fail-closed）。
   */
  countChanges(
    worktreePath: string,
    originalHeadCommit: string,
  ): WorktreeChanges | null {
    try {
      // 未提交文件（含 untracked）
      const statusOutput = execFileSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const changedFiles = statusOutput ? statusOutput.split("\n").length : 0;

      // 相对原始 HEAD 的新 commit
      let commits = 0;
      if (originalHeadCommit) {
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

  /** Post-creation setup：符号链接 node_modules + 配置共享 hooks */
  private async postCreationSetup(worktreePath: string): Promise<void> {
    const log = getLogger();

    // 1. 符号链接 node_modules（避免重复安装）
    const nodeModules = join(this.gitRoot, "node_modules");
    const targetNodeModules = join(worktreePath, "node_modules");
    if (existsSync(nodeModules) && !existsSync(targetNodeModules)) {
      try {
        symlinkSync(nodeModules, targetNodeModules, "dir");
      } catch (err: any) {
        log.debug("WORKTREE", `node_modules 符号链接失败（非关键）: ${err.message}`);
      }
    }

    // 2. 配置 core.hooksPath（共享主仓库 hooks）
    const hooksPath = join(this.gitRoot, ".git", "hooks");
    if (existsSync(hooksPath)) {
      try {
        execFileSync("git", ["config", "core.hooksPath", hooksPath], {
          cwd: worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        /* 非关键，忽略 */
      }
    }
  }

  // ── 辅助方法 ──

  private getCurrentBranch(): string {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.gitRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
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
