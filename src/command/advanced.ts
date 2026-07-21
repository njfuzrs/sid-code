/**
 * Spec 18 高级特性命令：/ps、/worktree、/cron
 */

import type { Command, AppContext, CommandResult } from "./types.ts";

/** 时长格式化 */
function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** /ps — 列出后台任务和并发会话 */
export class PsCommand implements Command {
  name() { return "ps"; }
  aliases() { return ["tasks"]; }
  description() { return "列出后台任务和活跃会话"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const { getAllTasks, isShellTask, isAgentTask } = await import("../task/index.ts");
    const { listActiveSessions } = await import("../session/concurrent.ts");

    const lines: string[] = [];

    // 后台任务
    const tasks = getAllTasks();
    lines.push("后台任务:");
    if (tasks.length === 0) {
      lines.push("  (无)");
    } else {
      for (const t of tasks) {
        const age = fmtAge(Date.now() - t.startTime);
        let detail = "";
        if (isShellTask(t)) {
          detail = t.command.slice(0, 50);
        } else if (isAgentTask(t)) {
          detail = `[${t.agentType}] ${t.description}`.slice(0, 50);
        }
        lines.push(`  ${t.id}  ${t.status.padEnd(9)} ${age.padStart(4)}  ${detail}`);
      }
    }

    // 并发会话
    const sessions = listActiveSessions();
    lines.push("", "活跃会话:");
    if (sessions.length === 0) {
      lines.push("  (无)");
    } else {
      for (const s of sessions) {
        const age = fmtAge(Date.now() - s.startedAt);
        const team = s.team ? ` team=${s.team}` : "";
        // 完整展示 sessionId（新格式 YYYYMMDD-HHMMSS-<hex> 仅 24 字符，便于直接复制去 -r 恢复）。
        // 旧实现 slice(0,8) 在新格式下只剩日期串、无法区分同日会话。
        lines.push(`  ${s.sessionId.padEnd(24)}  pid=${s.pid}  ${s.kind.padEnd(11)} ${age.padStart(4)}  ${s.cwd}${team}`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /worktree — 管理 Git Worktree */
export class WorktreeCommand implements Command {
  name() { return "worktree"; }
  aliases() { return ["wt"]; }
  description() { return "管理 Git Worktree (list/clean)"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const trimmed = args.trim();
    const { findGitRoot, getCurrentWorktreeSession } = await import("../worktree/manager.ts");

    const gitRoot = findGitRoot(process.cwd());
    if (!gitRoot) {
      return { kind: "message", message: "当前目录不在 Git 仓库中" };
    }

    if (trimmed === "clean") {
      const { cleanupStaleWorktrees } = await import("../worktree/cleanup.ts");
      const current = getCurrentWorktreeSession();
      const n = await cleanupStaleWorktrees(gitRoot, 30, current?.worktreePath);
      return { kind: "message", message: `已清理 ${n} 个过期临时 Worktree` };
    }

    // 默认 list（P2-7：显示 branch / age / 变更状态）
    const { readdirSync, existsSync, statSync } = await import("fs");
    const { join } = await import("path");
    const { execFileSync } = await import("child_process");
    const { isEphemeralWorktree } = await import("../worktree/cleanup.ts");
    const wtDir = join(gitRoot, ".sid-code", "worktrees");
    const lines: string[] = ["Worktrees:"];

    /** 读取某 worktree 的 branch + 是否有未提交变更 */
    const describe = (path: string): { branch: string; dirty: boolean } => {
      let branch = "?";
      let dirty = false;
      try {
        branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }).trim() || "?";
      } catch { /* 忽略 */ }
      try {
        const status = execFileSync("git", ["status", "--porcelain"], {
          cwd: path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        dirty = status.length > 0;
      } catch { /* 忽略 */ }
      return { branch, dirty };
    };

    const current = getCurrentWorktreeSession();
    if (current) {
      const d = describe(current.worktreePath);
      lines.push(`  * ${current.worktreeName} (当前) [${d.branch}]${d.dirty ? " ✎未提交" : ""} → ${current.worktreePath}`);
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
        } catch { /* 忽略 */ }
        const d = describe(full);
        const tag = isEphemeralWorktree(dirName) ? "临时" : "命名";
        lines.push(`    ${dirName} [${d.branch}] ${tag} ${age}${d.dirty ? " ✎未提交" : ""}`);
      }
      if (dirs.length === 0 && !current) lines.push("  (无)");
    } else if (!current) {
      lines.push("  (无)");
    }

    lines.push("", "提示: /worktree clean 清理过期临时 Worktree");
    return { kind: "message", message: lines.join("\n") };
  }
}

/** /cron — 管理定时任务 */
export class CronCommand implements Command {
  name() { return "cron"; }
  // schedule：对齐 claude-code 命名（CC /schedule 做本地定时任务，我们用 /cron 覆盖同能力）。
  // 云端 Routine 部分不做（无云端基建，见方案 §6）。
  aliases() { return ["schedule"]; }
  description() { return "管理定时任务 (list/delete)"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const { getScheduler } = await import("../cron/scheduler.ts");
    const scheduler = getScheduler();
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] || "list";

    if (sub === "delete" || sub === "rm") {
      const id = parts[1];
      if (!id) return { kind: "message", message: "用法: /cron delete <id>" };
      const ok = scheduler.removeTask(id);
      return { kind: "message", message: ok ? `已删除任务 ${id}` : `任务 ${id} 不存在` };
    }

    // list
    const tasks = scheduler.listTasks();
    const lines = ["定时任务:"];
    if (tasks.length === 0) {
      lines.push("  (无)");
    } else {
      for (const t of tasks) {
        const kind = t.recurring ? "循环" : "一次性";
        const durable = t.durable ? " [持久]" : "";
        lines.push(`  ${t.id}  ${t.cron.padEnd(16)} ${kind}${durable}  ${t.prompt.slice(0, 40)}`);
      }
    }
    return { kind: "message", message: lines.join("\n") };
  }
}
