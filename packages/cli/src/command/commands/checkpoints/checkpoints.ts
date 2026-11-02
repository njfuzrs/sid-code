import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /checkpoints 命令 */
export class CheckpointsCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { getCheckpointManager } = await import("@sid-code/core/checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.checkpointSessionId ?? ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    const snapshots = cpMgr.listSnapshots();

    if (snapshots.length === 0) {
      return { type: "text", value: "暂无快照历史" };
    }

    const lines = ["快照历史（最近 10 条）:", ""];

    // 只显示最近 10 条
    const recent = snapshots.slice(-10).reverse();

    for (const s of recent) {
      const time = new Date(s.timestamp);
      const timeStr = this.formatTime(time);
      const fileCountStr = `${s.fileCount} 个文件`;
      lines.push(
        `  ${s.id}  ${timeStr}  ${s.toolName.padEnd(8)}  ${s.toolSummary.slice(0, 40)}  (${fileCountStr})`,
      );
    }

    lines.push("");
    lines.push("使用 /restore <ID> 恢复到指定快照点");
    lines.push("使用 /undo 撤销最近一次变更");

    return { type: "text", value: lines.join("\n") };
  }

  private formatTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return `${days} 天前`;
  }
}
