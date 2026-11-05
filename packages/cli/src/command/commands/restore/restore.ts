import { emitRewind } from "@sid-code/core/session/rewind-telemetry.ts";
import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /restore 命令 */
export class RestoreCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const snapshotId = args.trim();

    if (!snapshotId) {
      return errorText("用法: /restore <快照ID>\n使用 /checkpoints 查看可用快照");
    }

    const { getCheckpointManager } = await import("@sid-code/core/checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.checkpointSessionId ?? ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    // 获取快照详情
    const snapshot = cpMgr.getSnapshotDetail(snapshotId);
    if (!snapshot) {
      // G2：失败与空转也记——只在成功时记会让「回滚成功率」的分母只剩成功路径
      emitRewind("restore", "nothing", { snapshot_id: snapshotId, reason: "not_found" });
      return errorText(`快照不存在: ${snapshotId}`);
    }

    // 显示确认信息（需要用户确认）
    const allSnapshots = cpMgr.listSnapshots();
    const targetIndex = allSnapshots.findIndex((s) => s.id === snapshotId);
    const snapshotsToRollback = allSnapshots.slice(targetIndex + 1);

    if (snapshotsToRollback.length === 0) {
      emitRewind("restore", "nothing", { snapshot_id: snapshotId, reason: "already_latest" });
      return { type: "text", value: `快照 ${snapshotId} 已经是最新状态，无需恢复` };
    }

    const lines = [`将回滚以下 ${snapshotsToRollback.length} 个快照:`, ""];

    for (const s of snapshotsToRollback.reverse()) {
      lines.push(`  ${s.id}: ${s.toolName} ${s.toolSummary.slice(0, 40)}`);
    }

    // 收集受影响的文件
    const affectedFiles = new Set<string>();
    for (const s of snapshotsToRollback) {
      const detail = cpMgr.getSnapshotDetail(s.id);
      if (detail) {
        for (const f of detail.files) {
          affectedFiles.add(f.filePath);
        }
      }
    }

    lines.push("");
    lines.push(`涉及 ${affectedFiles.size} 个文件:`);
    for (const file of Array.from(affectedFiles).slice(0, 10)) {
      lines.push(`  ${file}`);
    }
    if (affectedFiles.size > 10) {
      lines.push(`  ... 还有 ${affectedFiles.size - 10} 个文件`);
    }

    lines.push("");
    lines.push("⚠️ 此操作将丢失这些快照之后的所有变更！");
    lines.push("");
    lines.push("确认恢复？请回复 'yes' 确认，或其他任意内容取消。");

    // 返回需要确认的消息
    return {
      type: "confirm",
      message: lines.join("\n"),
      onConfirm: async () => {
        // G2：抛错也要记 error。磁盘错 / 索引损坏走的是抛错路径，原先只有「返回 null」
        // 才记一条，于是回滚的真实失败在轨迹里整条缺失，成功率的分母偏向非失败路径。
        const result = await cpMgr.restoreToSnapshot(snapshotId).catch((e: unknown) => {
          emitRewind("restore", "error", {
            snapshot_id: snapshotId,
            error_name: (e as Error)?.name ?? "Error",
          });
          throw e;
        });
        if (result) {
          emitRewind("restore", "ok", {
            snapshot_id: snapshotId,
            files_restored: result.files.length,
            snapshots_rolled_back: result.snapshotsRolledBack,
          });
          const fileActions = result.files
            .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
            .join("\n");
          return {
            type: "text",
            value: `已恢复到快照 ${result.targetSnapshotId}，回滚了 ${result.snapshotsRolledBack} 个快照:\n${fileActions}`,
          };
        }
        emitRewind("restore", "error", { snapshot_id: snapshotId });
        return errorText("恢复失败");
      },
    };
  }
}
