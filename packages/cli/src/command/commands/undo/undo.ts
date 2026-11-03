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
        const fileActions = result.files
          .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
          .join("\n");
        return {
          type: "text",
          value: `已撤销快照 ${result.snapshotId}:\n${fileActions}`,
        };
      }
      return { type: "text", value: `文件 ${trimmed} 没有可撤销的修改` };
    }

    // 回滚最近一次快照（可能包含多个文件）
    const result = await cpMgr.undo();
    if (result) {
      const fileActions = result.files
        .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
        .join("\n");
      return {
        type: "text",
        value: `已撤销快照 ${result.snapshotId}:\n${fileActions}`,
      };
    }
    return { type: "text", value: "没有可撤销的修改" };
  }
}
