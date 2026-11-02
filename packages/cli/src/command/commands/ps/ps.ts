/**
 * Spec 18 高级特性命令：/ps、/worktree、/cron
 */

import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { fmtAge } from "../shared/advanced.ts";

/** /ps — 列出后台任务和并发会话 */
export class PsCommand implements LocalCommandModule {
  async call(_args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const { getAllTasks, isPanelTask, isShellTask, isAgentTask } =
      await import("@sid-code/core/task/index.ts");
    const { listActiveSessions } = await import("@sid-code/core/session/concurrent.ts");

    const lines: string[] = [];

    // 后台任务（经 isPanelTask 单一闸门，见 task/types.ts：前台子代理不算后台任务）
    const tasks = getAllTasks().filter(isPanelTask);
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
        lines.push(
          `  ${s.sessionId.padEnd(24)}  pid=${s.pid}  ${s.kind.padEnd(11)} ${age.padStart(4)}  ${s.cwd}${team}`,
        );
      }
    }

    return { type: "text", value: lines.join("\n") };
  }
}
