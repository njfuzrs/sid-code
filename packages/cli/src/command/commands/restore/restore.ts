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

    // P3/P4：没进快照的目标**从未被保护**（checkpoint 不保护它们），必须分类点明。
    // 不点明的话，用户会把「已恢复」理解成「所有改动都回退了」，而实际上这些目标
    // 停在回滚后的状态——静默的不完整保护比没有保护更危险。
    // 范围取 targetIndex 起（含目标快照）：目标快照自身跳过的文件，同样在恢复范围之外。
    // 三类原因（超限 / 非普通文件 / 无法判定类型）文案分开，交给纯函数统一渲染。
    const skippedEntries: UnprotectedEntry[] = [];
    for (const s of allSnapshots.slice(targetIndex)) {
      skippedEntries.push(...(cpMgr.getSnapshotDetail(s.id)?.skippedFiles ?? []));
    }
    lines.push(...formatUnprotectedLines(skippedEntries));

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

/** 一个「从未进快照」的目标（`Snapshot.skippedFiles` 的元素）。 */
export interface UnprotectedEntry {
  filePath: string;
  bytes: number;
  reason?: "non-regular" | "unreadable";
}

/**
 * 把「没进快照的目标」渲染成确认面板里的几行（P3/P4）。
 *
 * 抽成纯函数是为了让文案能被单测直接锁住：`bytes` 对非普通文件与不可读路径恒为 0，
 * 三类原因混成一句「超过单文件上限 (0.0MB)」就是撒谎——把设备/目录说成超大文件，
 * 把非法路径说成设备文件，都属同一类误导。`reason` 缺省即 `too-large`（老分片没有该字段）。
 */
export function formatUnprotectedLines(entries: UnprotectedEntry[]): string[] {
  const MAX_PREVIEW = 5;
  const tooLarge: UnprotectedEntry[] = [];
  const nonRegular: UnprotectedEntry[] = [];
  const unreadable: UnprotectedEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.filePath)) continue; // 同一路径可能出现在多个快照里
    seen.add(e.filePath);
    if (e.reason === "non-regular") nonRegular.push(e);
    else if (e.reason === "unreadable") unreadable.push(e);
    else tooLarge.push(e);
  }
  if (tooLarge.length === 0 && nonRegular.length === 0 && unreadable.length === 0) return [];

  const lines: string[] = [""];
  if (tooLarge.length > 0) {
    lines.push(
      `⚠️ 另有 ${tooLarge.length} 个文件超过单文件上限，从未进快照，本次恢复不会改动它们:`,
    );
    for (const e of tooLarge.slice(0, MAX_PREVIEW)) {
      lines.push(`  ${e.filePath} (${(e.bytes / 1024 / 1024).toFixed(1)}MB)`);
    }
    if (tooLarge.length > MAX_PREVIEW) lines.push(`  ... 还有 ${tooLarge.length - MAX_PREVIEW} 个`);
  }
  if (nonRegular.length > 0) {
    lines.push(
      `⚠️ 另有 ${nonRegular.length} 个非普通文件（目录/设备/软链等）不是可回退目标，从未进快照，本次恢复不会改动它们:`,
    );
    for (const e of nonRegular.slice(0, MAX_PREVIEW)) lines.push(`  ${e.filePath}`);
    if (nonRegular.length > MAX_PREVIEW) {
      lines.push(`  ... 还有 ${nonRegular.length - MAX_PREVIEW} 个`);
    }
  }
  if (unreadable.length > 0) {
    lines.push(
      `⚠️ 另有 ${unreadable.length} 个路径无法判定类型（父目录是普通文件/无权访问等），从未进快照，本次恢复不会改动它们:`,
    );
    for (const e of unreadable.slice(0, MAX_PREVIEW)) lines.push(`  ${e.filePath}`);
    if (unreadable.length > MAX_PREVIEW) {
      lines.push(`  ... 还有 ${unreadable.length - MAX_PREVIEW} 个`);
    }
  }
  return lines;
}
