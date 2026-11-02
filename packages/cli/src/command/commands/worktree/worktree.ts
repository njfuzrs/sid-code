/**
 * Spec 18 高级特性命令：/ps、/worktree、/cron
 */

import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { fmtAge } from "../shared/advanced.ts";

/** /worktree — 管理 Git Worktree */
export class WorktreeCommand implements LocalCommandModule {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const trimmed = args.trim();
    const { findGitRootForAgent, getCurrentWorktreeSession } =
      await import("@sid-code/core/worktree/manager.ts");

    // W17：enter_worktree 之后 process.cwd() 是 worktree，`findGitRoot` 会返回它自己，
    // `/worktree clean` 扫的就成了 worktree 内部的 .sid-code/worktrees（恒为 0 个）。
    const gitRoot = findGitRootForAgent(process.cwd());
    if (!gitRoot) {
      return { type: "text", value: "当前目录不在 Git 仓库中" };
    }

    if (trimmed === "clean") {
      const { cleanupStaleWorktrees } = await import("@sid-code/core/worktree/cleanup.ts");
      const current = getCurrentWorktreeSession();
      const n = await cleanupStaleWorktrees(gitRoot, 30, current?.worktreePath);
      return { type: "text", value: `已清理 ${n} 个过期临时 Worktree` };
    }

    // 默认 list（P2-7：显示 branch / age / 变更状态）
    const { readdirSync, existsSync, statSync } = await import("fs");
    const { join } = await import("path");
    const { execFileSync } = await import("child_process");
    const { isEphemeralWorktree } = await import("@sid-code/core/worktree/cleanup.ts");
    const wtDir = join(gitRoot, ".sid-code", "worktrees");
    const lines: string[] = ["Worktrees:"];

    /** 读取某 worktree 的 branch + 是否有未提交变更 */
    const describe = (path: string): { branch: string; dirty: boolean } => {
      let branch = "?";
      let dirty = false;
      try {
        branch =
          execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: path,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim() || "?";
      } catch {
        /* 忽略 */
      }
      try {
        const status = execFileSync("git", ["status", "--porcelain"], {
          cwd: path,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        dirty = status.length > 0;
      } catch {
        /* 忽略 */
      }
      return { branch, dirty };
    };

    const current = getCurrentWorktreeSession();
    if (current) {
      const d = describe(current.worktreePath);
      lines.push(
        `  * ${current.worktreeName} (当前) [${d.branch}]${d.dirty ? " ✎未提交" : ""} → ${current.worktreePath}`,
      );
    }

    if (existsSync(wtDir)) {
      let dirs: string[] = [];
      try {
        dirs = readdirSync(wtDir);
      } catch {
        dirs = [];
      }
      for (const dirName of dirs) {
        if (current && dirName === current.worktreeName) continue;
        const full = join(wtDir, dirName);
        let age = "";
        try {
          age = fmtAge(Date.now() - statSync(full).mtimeMs);
        } catch {
          /* 忽略 */
        }
        const d = describe(full);
        const tag = isEphemeralWorktree(dirName) ? "临时" : "命名";
        lines.push(`    ${dirName} [${d.branch}] ${tag} ${age}${d.dirty ? " ✎未提交" : ""}`);
      }
      if (dirs.length === 0 && !current) lines.push("  (无)");
    } else if (!current) {
      lines.push("  (无)");
    }

    lines.push("", "提示: /worktree clean 清理过期临时 Worktree");
    return { type: "text", value: lines.join("\n") };
  }
}
