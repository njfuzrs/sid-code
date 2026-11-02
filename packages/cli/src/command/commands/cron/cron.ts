/**
 * Spec 18 高级特性命令：/ps、/worktree、/cron
 */

import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /cron — 管理定时任务 */
export class CronCommand implements LocalCommandModule {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const { getScheduler } = await import("@sid-code/core/cron/scheduler.ts");
    const scheduler = getScheduler();
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] || "list";

    if (sub === "delete" || sub === "rm") {
      const id = parts[1];
      if (!id) return { type: "text", value: "用法: /cron delete <id>" };
      const ok = scheduler.removeTask(id);
      return { type: "text", value: ok ? `已删除任务 ${id}` : `任务 ${id} 不存在` };
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
    return { type: "text", value: lines.join("\n") };
  }
}
