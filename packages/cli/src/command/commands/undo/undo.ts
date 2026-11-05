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
      // G2：抛错也要记 error，不能只记「返回 null」。磁盘错 / 索引损坏这类**真实失败**
      // 走的是抛错路径，只记空转会让「回滚成功率」的分母偏向非失败路径。
      const result = await cpMgr.undoFile(trimmed).catch((e: unknown) => {
        emitRewind("undo_file", "error", {
          path_sha12: sha12(trimmed),
          error_name: (e as Error)?.name ?? "Error",
        });
        throw e;
      });
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
    const result = await cpMgr.undo().catch((e: unknown) => {
      // G2：同上，抛错也是「回滚失败」的一种，不能从分母里消失
      emitRewind("undo", "error", { error_name: (e as Error)?.name ?? "Error" });
      throw e;
    });
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
