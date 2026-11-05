import { emitRewind, sha12 } from "@sid-code/core/session/rewind-telemetry.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /undo 命令 */
export class UndoCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { getCheckpointManager } = await import("@sid-code/core/checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.checkpointSessionId ?? ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    const trimmed = args.trim();

    // 如果指定了文件路径，回滚单个文件
    if (trimmed) {
      const result = await cpMgr.undoFile(trimmed);
      if (result) {
        // G2：只记路径摘要不记原文——路径是用户项目结构，与 PostToolUse 里的路径同级敏感，
        // 而回滚统计只需要「撤销的是同一个文件吗」，不需要它是哪个文件（见 rewind-telemetry.ts）
        emitRewind("undo_file", "ok", {
          snapshot_id: result.snapshotId,
          files_restored: result.files.length,
          path_sha12: sha12(trimmed),
        });
        const fileActions = result.files
          .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
          .join("\n");
        return {
          type: "text",
          value: `已撤销快照 ${result.snapshotId}:\n${fileActions}`,
        };
      }
      emitRewind("undo_file", "nothing", { path_sha12: sha12(trimmed) });
      return { type: "text", value: `文件 ${trimmed} 没有可撤销的修改` };
    }

    // 回滚最近一次快照（可能包含多个文件）
    const result = await cpMgr.undo();
    if (result) {
      emitRewind("undo", "ok", {
        snapshot_id: result.snapshotId,
        files_restored: result.files.length,
      });
      const fileActions = result.files
        .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
        .join("\n");
      return {
        type: "text",
        value: `已撤销快照 ${result.snapshotId}:\n${fileActions}`,
      };
    }
    emitRewind("undo", "nothing", {});
    return { type: "text", value: "没有可撤销的修改" };
  }
}
