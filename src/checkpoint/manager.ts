/**
 * Checkpoint 文件快照管理器
 * 在 write/edit 工具执行前自动保存文件快照，支持 /undo 回滚
 *
 * 存储策略：
 * - 第一次保存完整内容（>1KB 时 gzip 压缩 + base64）
 * - 后续保存增量 diff（LCS 算法）
 * - 每文件最多 50 个 checkpoint，总共最多 200MB，30 天自动清理
 * - 存储路径：~/.sid-code/checkpoints/<session-id>/
 */

import { join } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, unlinkSync } from "fs";
import { computeDiff, type DiffResult } from "./diff.ts";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import type { CheckpointConfig } from "../config/config.ts";

/** 快照组：一次工具调用产生的所有文件变更 */
export interface Snapshot {
  /** 快照 ID（自增短 ID，如 "s1", "s2"） */
  id: string;
  /** 创建时间 */
  timestamp: number;
  /** 触发快照的工具名称 */
  toolName: string;
  /** 触发快照的工具参数摘要（如文件路径） */
  toolSummary: string;
  /** 关联的消息 ID（可选，用于定位对话上下文） */
  messageId?: string;
  /** 包含的文件变更列表 */
  files: SnapshotFile[];
}

/** 快照中的单个文件 */
export interface SnapshotFile {
  /** 文件路径 */
  filePath: string;
  /** 文件在快照前是否存在（false 表示新创建的文件） */
  existedBefore: boolean;
  /** 存储类型 */
  type: "full" | "diff";
  /** 完整内容（type=full 时） */
  content?: string;
  /** 是否压缩 */
  compressed?: boolean;
  /** 增量差异（type=diff 时） */
  diff?: DiffResult;
}

/** 索引文件格式（新版） */
export interface CheckpointIndex {
  sessionId: string;
  createdAt: number;
  /** 快照序列号计数器 */
  nextId: number;
  /** 按时间顺序排列的快照列表 */
  snapshots: Snapshot[];
  /** 文件路径 → 最新完整内容的快照 ID（加速查找） */
  latestFullMap: Record<string, string>;
}

/** 旧版索引格式（兼容） */
interface LegacyCheckpointEntry {
  filePath: string;
  timestamp: number;
  type: "full" | "diff";
  content?: string;
  compressed?: boolean;
  diff?: DiffResult;
}

interface LegacyFileCheckpoints {
  filePath: string;
  entries: LegacyCheckpointEntry[];
}

interface LegacyCheckpointIndex {
  sessionId: string;
  createdAt: number;
  files: Record<string, LegacyFileCheckpoints>;
}

/** Undo 结果 */
export interface UndoResult {
  /** 回滚的快照 ID */
  snapshotId: string;
  /** 回滚的文件列表 */
  files: Array<{
    filePath: string;
    /** restored=恢复了内容, deleted=删除了新创建的文件 */
    action: "restored" | "deleted";
  }>;
}

/** Restore 结果 */
export interface RestoreResult {
  /** 恢复到的目标快照 ID */
  targetSnapshotId: string;
  /** 回滚了多少个快照 */
  snapshotsRolledBack: number;
  /** 受影响的文件列表 */
  files: Array<{
    filePath: string;
    action: "restored" | "deleted";
  }>;
}

/** 快照摘要 */
export interface SnapshotSummary {
  id: string;
  timestamp: number;
  toolName: string;
  toolSummary: string;
  fileCount: number;
}

export class CheckpointManager {
  private sessionId: string;
  private baseDir: string;
  private index: CheckpointIndex;
  private dirty: boolean = false;
  private config: Required<CheckpointConfig>;

  constructor(sessionId: string, config?: CheckpointConfig) {
    this.sessionId = sessionId;
    this.baseDir = sidPaths.checkpoints(sessionId);
    this.index = {
      sessionId,
      createdAt: Date.now(),
      nextId: 1,
      snapshots: [],
      latestFullMap: {},
    };

    // 合并默认配置
    this.config = {
      enabled: config?.enabled ?? true,
      maxCheckpointsPerFile: config?.maxCheckpointsPerFile ?? 50,
      maxTotalSizeMb: config?.maxTotalSizeMb ?? 200,
      maxAgeDays: config?.maxAgeDays ?? 30,
      compressThresholdKb: config?.compressThresholdKb ?? 1,
      largeFileThresholdLines: config?.largeFileThresholdLines ?? 1000,
      hugeFileThresholdLines: config?.hugeFileThresholdLines ?? 10000,
    };
  }

  /** 初始化：创建目录 + 加载索引 */
  async init(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    const indexPath = join(this.baseDir, "index.json");
    if (existsSync(indexPath)) {
      try {
        const data = await Bun.file(indexPath).text();
        const parsed = JSON.parse(data);

        // 检测是否为旧格式
        if (parsed.files && !parsed.snapshots) {
          this.index = this.migrateLegacyIndex(parsed as LegacyCheckpointIndex);
          await this.saveIndex(); // 立即保存迁移后的索引
        } else {
          this.index = parsed;
        }
      } catch {
        // 索引损坏，重新创建
        this.index = {
          sessionId: this.sessionId,
          createdAt: Date.now(),
          nextId: 1,
          snapshots: [],
          latestFullMap: {},
        };
      }
    }

    // 清理过期的其他会话
    this.cleanupOldSessions();
  }

  /** 迁移旧格式索引到新格式 */
  private migrateLegacyIndex(legacy: LegacyCheckpointIndex): CheckpointIndex {
    const log = getLogger();
    log.info("CHECKPOINT", "检测到旧格式索引，正在迁移...");

    const snapshots: Snapshot[] = [];
    const latestFullMap: Record<string, string> = {};
    let nextId = 1;

    // 将每个文件的每个 entry 转换为独立的快照
    for (const [filePath, fileCheckpoints] of Object.entries(legacy.files)) {
      for (const entry of fileCheckpoints.entries) {
        const snapshotId = `s${nextId++}`;
        snapshots.push({
          id: snapshotId,
          timestamp: entry.timestamp,
          toolName: "write", // 旧格式无法区分工具，默认 write
          toolSummary: filePath,
          files: [{
            filePath: entry.filePath,
            existedBefore: entry.type === "diff" || (entry.content !== ""), // diff 或非空内容表示已存在
            type: entry.type,
            content: entry.content,
            compressed: entry.compressed,
            diff: entry.diff,
          }],
        });

        // 更新 latestFullMap
        if (entry.type === "full") {
          latestFullMap[filePath] = snapshotId;
        }
      }
    }

    // 按时间排序
    snapshots.sort((a, b) => a.timestamp - b.timestamp);

    log.info("CHECKPOINT", `迁移完成：${snapshots.length} 个快照`);

    return {
      sessionId: legacy.sessionId,
      createdAt: legacy.createdAt,
      nextId,
      snapshots,
      latestFullMap,
    };
  }

  /**
   * 创建快照组：在工具执行前调用
   * 一次调用可以保存多个文件的状态
   */
  async createSnapshot(
    filePaths: string[],
    toolName: string,
    toolSummary: string,
    messageId?: string,
  ): Promise<string> {
    if (!this.config.enabled) {
      return "";
    }

    const log = getLogger();
    const snapshotId = `s${this.index.nextId++}`;
    const files: SnapshotFile[] = [];

    try {
      for (const filePath of filePaths) {
        const file = Bun.file(filePath);
        const existedBefore = await file.exists();

        if (!existedBefore) {
          // 新文件，记录为空内容
          files.push({
            filePath,
            existedBefore: false,
            type: "full",
            content: "",
            compressed: false,
          });
          continue;
        }

        const currentContent = await file.text();
        const lastContent = await this.getLatestContentForFile(filePath);

        if (lastContent === null) {
          // 第一次：保存完整内容
          const compressThreshold = this.config.compressThresholdKb * 1024;
          const snapshotFile: SnapshotFile = {
            filePath,
            existedBefore: true,
            type: "full",
          };

          if (currentContent.length > compressThreshold) {
            // gzip 压缩 + base64
            const compressed = Bun.gzipSync(Buffer.from(currentContent, "utf-8"));
            snapshotFile.content = Buffer.from(compressed).toString("base64");
            snapshotFile.compressed = true;
          } else {
            snapshotFile.content = currentContent;
            snapshotFile.compressed = false;
          }

          files.push(snapshotFile);
          this.index.latestFullMap[filePath] = snapshotId;
        } else if (lastContent !== currentContent) {
          // 后续：保存增量 diff
          const diff = computeDiff(lastContent, currentContent);
          files.push({
            filePath,
            existedBefore: true,
            type: "diff",
            diff,
          });
        }
        // 内容没变，跳过
      }

      if (files.length > 0) {
        this.index.snapshots.push({
          id: snapshotId,
          timestamp: Date.now(),
          toolName,
          toolSummary,
          messageId,
          files,
        });

        this.dirty = true;
        // P1-2：写时双层 eviction（per-file 版本上限 + 总量上限），淘汰时保护 diff 链完整性。
        // 放在 push 之后、saveIndex 之前——确定性强、无需定时器（同 CC 写时淘汰思路）。
        await this.evictIfNeeded();
        await this.saveIndex();
        log.debug("CHECKPOINT", `已创建快照 ${snapshotId}: ${files.length} 个文件`);
      }

      return snapshotId;
    } catch (err: any) {
      log.warn("CHECKPOINT", `创建快照失败: ${err.message}`);
      return "";
    }
  }

  /**
   * 兼容旧 API：单文件快照
   * @deprecated 使用 createSnapshot 替代
   */
  async createCheckpoint(filePath: string): Promise<void> {
    await this.createSnapshot([filePath], "write", filePath);
  }

  /**
   * 撤销最近一次快照（回滚整组文件变更）
   * 如果快照中某文件是新创建的（existedBefore=false），则删除该文件
   */
  async undo(): Promise<UndoResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    const log = getLogger();
    const lastSnapshot = this.getLastSnapshot();
    if (!lastSnapshot) {
      return null;
    }

    const results: UndoResult["files"] = [];

    for (const file of lastSnapshot.files) {
      if (!file.existedBefore) {
        // 新创建的文件：删除它
        if (existsSync(file.filePath)) {
          try {
            unlinkSync(file.filePath);
            results.push({ filePath: file.filePath, action: "deleted" });
            log.info("CHECKPOINT", `已删除新文件: ${file.filePath}`);
          } catch (err: any) {
            log.warn("CHECKPOINT", `删除文件失败: ${file.filePath} - ${err.message}`);
          }
        }
      } else {
        // 已有文件：恢复到快照前的内容
        const content = await this.rebuildContentBeforeSnapshot(file.filePath, lastSnapshot.id);
        if (content !== null) {
          try {
            await Bun.write(file.filePath, content);
            results.push({ filePath: file.filePath, action: "restored" });
            log.info("CHECKPOINT", `已恢复文件: ${file.filePath}`);
          } catch (err: any) {
            log.warn("CHECKPOINT", `恢复文件失败: ${file.filePath} - ${err.message}`);
          }
        }
      }
    }

    // 移除该快照
    this.removeLastSnapshot();
    await this.saveIndex();

    return { snapshotId: lastSnapshot.id, files: results };
  }

  /**
   * 撤销指定文件的最近一次变更
   */
  async undoFile(filePath: string): Promise<UndoResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    const log = getLogger();

    // 找到最近修改该文件的快照
    for (let i = this.index.snapshots.length - 1; i >= 0; i--) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find(f => f.filePath === filePath);

      if (fileInSnapshot) {
        if (!fileInSnapshot.existedBefore) {
          // 新创建的文件：删除它
          if (existsSync(filePath)) {
            try {
              unlinkSync(filePath);
              log.info("CHECKPOINT", `已删除新文件: ${filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `删除文件失败: ${filePath} - ${err.message}`);
              return null;
            }
          }
        } else {
          // 已有文件：恢复到快照前的内容
          const content = await this.rebuildContentBeforeSnapshot(filePath, snapshot.id);
          if (content !== null) {
            try {
              await Bun.write(filePath, content);
              log.info("CHECKPOINT", `已恢复文件: ${filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `恢复文件失败: ${filePath} - ${err.message}`);
              return null;
            }
          } else {
            return null;
          }
        }

        // 从快照中移除该文件
        snapshot.files = snapshot.files.filter(f => f.filePath !== filePath);

        // 如果快照为空，移除整个快照
        if (snapshot.files.length === 0) {
          this.index.snapshots.splice(i, 1);
        }

        await this.saveIndex();

        return {
          snapshotId: snapshot.id,
          files: [{
            filePath,
            action: fileInSnapshot.existedBefore ? "restored" : "deleted",
          }],
        };
      }
    }

    return null;
  }

  /**
   * 恢复到指定快照点（回滚该快照之后的所有变更）
   */
  async restoreToSnapshot(snapshotId: string): Promise<RestoreResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    const log = getLogger();
    const targetIndex = this.index.snapshots.findIndex(s => s.id === snapshotId);

    if (targetIndex === -1) {
      log.warn("CHECKPOINT", `快照不存在: ${snapshotId}`);
      return null;
    }

    // 收集所有需要回滚的快照（从最新到目标快照之后）
    const snapshotsToRollback = this.index.snapshots.slice(targetIndex + 1).reverse();
    const affectedFiles = new Map<string, { action: "restored" | "deleted" }>();

    for (const snapshot of snapshotsToRollback) {
      for (const file of snapshot.files) {
        // 只处理每个文件的第一次遇到（最新状态）
        if (affectedFiles.has(file.filePath)) {
          continue;
        }

        if (!file.existedBefore) {
          // 新创建的文件：删除它
          if (existsSync(file.filePath)) {
            try {
              unlinkSync(file.filePath);
              affectedFiles.set(file.filePath, { action: "deleted" });
              log.info("CHECKPOINT", `已删除新文件: ${file.filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `删除文件失败: ${file.filePath} - ${err.message}`);
            }
          }
        } else {
          // 已有文件：恢复到目标快照时的内容
          const content = await this.rebuildContentAtSnapshot(file.filePath, snapshotId);
          if (content !== null) {
            try {
              await Bun.write(file.filePath, content);
              affectedFiles.set(file.filePath, { action: "restored" });
              log.info("CHECKPOINT", `已恢复文件: ${file.filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `恢复文件失败: ${file.filePath} - ${err.message}`);
            }
          }
        }
      }
    }

    // 移除目标快照之后的所有快照
    this.index.snapshots = this.index.snapshots.slice(0, targetIndex + 1);
    await this.saveIndex();

    return {
      targetSnapshotId: snapshotId,
      snapshotsRolledBack: snapshotsToRollback.length,
      files: Array.from(affectedFiles.entries()).map(([filePath, { action }]) => ({
        filePath,
        action,
      })),
    };
  }

  /**
   * 列出所有快照（用于 /checkpoints 命令）
   */
  listSnapshots(): SnapshotSummary[] {
    return this.index.snapshots.map(s => ({
      id: s.id,
      timestamp: s.timestamp,
      toolName: s.toolName,
      toolSummary: s.toolSummary,
      fileCount: s.files.length,
    }));
  }

  /**
   * 查看指定快照的详情
   */
  getSnapshotDetail(snapshotId: string): Snapshot | null {
    return this.index.snapshots.find(s => s.id === snapshotId) || null;
  }

  /**
   * 获取指定文件在最新快照时的内容
   */
  private async getLatestContentForFile(filePath: string): Promise<string | null> {
    // 从最新快照往前找，找到第一个包含该文件的快照
    for (let i = this.index.snapshots.length - 1; i >= 0; i--) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find(f => f.filePath === filePath);
      if (fileInSnapshot) {
        return this.rebuildContentAtSnapshot(filePath, snapshot.id);
      }
    }
    return null;
  }

  /**
   * 重建指定文件在指定快照时的内容
   */
  private async rebuildContentAtSnapshot(filePath: string, snapshotId: string): Promise<string | null> {
    const targetIndex = this.index.snapshots.findIndex(s => s.id === snapshotId);
    if (targetIndex === -1) return null;

    // 找到最近的 full 快照
    let baseContent = "";
    let baseSnapshotIndex = -1;

    for (let i = targetIndex; i >= 0; i--) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find(f => f.filePath === filePath);

      if (fileInSnapshot && fileInSnapshot.type === "full") {
        if (fileInSnapshot.compressed && fileInSnapshot.content) {
          const buf = Buffer.from(fileInSnapshot.content, "base64");
          const decompressed = Bun.gunzipSync(buf);
          baseContent = Buffer.from(decompressed).toString("utf-8");
        } else {
          baseContent = fileInSnapshot.content || "";
        }
        baseSnapshotIndex = i;
        break;
      }
    }

    if (baseSnapshotIndex === -1) {
      return null;
    }

    // 逐步 apply diff
    let content = baseContent;
    const { applyDiff } = await import("./diff.ts");

    for (let i = baseSnapshotIndex + 1; i <= targetIndex; i++) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find(f => f.filePath === filePath);

      if (fileInSnapshot && fileInSnapshot.type === "diff" && fileInSnapshot.diff) {
        content = applyDiff(content, fileInSnapshot.diff);
      }
    }

    return content;
  }

  /**
   * 重建指定文件在指定快照之前的内容（用于 undo）
   */
  private async rebuildContentBeforeSnapshot(filePath: string, snapshotId: string): Promise<string | null> {
    const targetIndex = this.index.snapshots.findIndex(s => s.id === snapshotId);
    if (targetIndex === -1 || targetIndex === 0) return null;

    // 重建到前一个快照的内容
    return this.rebuildContentAtSnapshot(filePath, this.index.snapshots[targetIndex - 1].id);
  }

  // ─────────────────────────────────────────────────────────────
  // P1-2：checkpoint eviction（写时淘汰 + diff 链重锚定）
  //
  // 结构约束（决定不能照搬 CC 的 per-file slice(-MAX)）：
  //   - per-session 单 index.json，所有快照内联其中，按 timestamp 时间序排列。
  //   - 同一文件跨快照是 diff 链：首存 full，后续存相对上一版本的 diff。
  //     重建靠 rebuildContentAtSnapshot：从目标往前找最近 full 作基点再逐步 applyDiff。
  //   - 盲删最旧快照/条目会切断 diff 链 → undo/restore 该文件 rebuild 返回 null。
  //
  // 因此淘汰粒度是「删快照内某文件的 SnapshotFile 条目」，且删某文件最旧条目前，
  // 若它是 full 且后面还有该文件的 diff 依赖它，先把「紧邻的下一个该文件 diff」
  // 用 rebuildContentAtSnapshot 重建成内容、原地改写成新 full（重锚定基点），再删旧条目。
  // ─────────────────────────────────────────────────────────────

  /** 写时双层淘汰：先 per-file 版本上限（A），再总量上限（B）。淘汰后重建 latestFullMap。 */
  private async evictIfNeeded(): Promise<void> {
    try {
      await this.evictPerFile();
      await this.evictBySize();
    } catch (err: any) {
      // 淘汰失败绝不能影响快照本身已成功写入——仅告警。
      getLogger().warn("CHECKPOINT", `checkpoint 淘汰失败（不阻断）: ${err?.message}`);
    } finally {
      // 保留铁律 #3：淘汰后重建 latestFullMap，避免加速查找指向已删快照。
      this.rebuildLatestFullMap();
    }
  }

  /** 收集某文件在所有快照中的出现位置（按时间序，返回 {snapshotIndex, file}）。 */
  private collectFileEntries(filePath: string): Array<{ snapshotIndex: number; file: SnapshotFile }> {
    const entries: Array<{ snapshotIndex: number; file: SnapshotFile }> = [];
    for (let i = 0; i < this.index.snapshots.length; i++) {
      const f = this.index.snapshots[i].files.find((x) => x.filePath === filePath);
      if (f) entries.push({ snapshotIndex: i, file: f });
    }
    return entries;
  }

  /** 全仓所有出现过的文件路径（去重）。 */
  private allTrackedFilePaths(): string[] {
    const set = new Set<string>();
    for (const s of this.index.snapshots) {
      for (const f of s.files) set.add(f.filePath);
    }
    return Array.from(set);
  }

  /**
   * 确保删除某文件在 fromSnapshotIndex 处的 full 条目不会切断后续 diff 链：
   * 若「紧邻的下一个该文件条目」是 diff（依赖被删 full），先把它 rebuild 成内容、原地改写成新 full。
   *
   * 返回 true 表示「删除该 full 是安全的」：
   *   - 后续紧邻条目是 full（已有独立基点）→ 直接安全；
   *   - 后续紧邻条目是 diff → 已成功重锚定为 full → 安全；
   *   - 后续无该文件任何条目 → 无人依赖该 full → 安全（size 淘汰按 LRU 丢弃老文件的孤版本，
   *     近期窗口由 evictBySize 的 MIN_KEEP 保护；per-file 淘汰因 count>max 恒有更新版本，走不到这里）。
   * 返回 false 仅在 diff 重建异常（无法安全重锚定）时——调用方应放弃删除以免切链。
   */
  private async reanchorFullForFile(filePath: string, fromSnapshotIndex: number): Promise<boolean> {
    // 找 fromSnapshotIndex 之后（不含）该文件的下一个条目。
    for (let i = fromSnapshotIndex + 1; i < this.index.snapshots.length; i++) {
      const f = this.index.snapshots[i].files.find((x) => x.filePath === filePath);
      if (!f) continue;
      if (f.type === "full") {
        // 后面已有独立 full 基点，旧 full 可直接删，无需重锚定。
        return true;
      }
      // f 是 diff：把它重建成内容，原地改写成 full（新基点）。
      const rebuilt = await this.rebuildContentAtSnapshot(filePath, this.index.snapshots[i].id);
      if (rebuilt === null) {
        // 无法重建（异常）→ 保守失败，调用方应放弃删除旧 full 以免切链。
        return false;
      }
      // 原地改写为 full（复用压缩阈值逻辑）。
      const compressThreshold = this.config.compressThresholdKb * 1024;
      f.type = "full";
      f.diff = undefined;
      if (rebuilt.length > compressThreshold) {
        const compressed = Bun.gzipSync(Buffer.from(rebuilt, "utf-8"));
        f.content = Buffer.from(compressed).toString("base64");
        f.compressed = true;
      } else {
        f.content = rebuilt;
        f.compressed = false;
      }
      this.dirty = true;
      return true;
    }
    // 该文件在 fromSnapshotIndex 之后无其他条目 → 无 diff 依赖该 full → 删除安全（LRU 丢弃老孤版本）。
    return true;
  }

  /**
   * 删除某文件的一个 SnapshotFile 条目（按 snapshotIndex 定位）。
   * 若删空该快照的 files，则整组移除（复用 restore 的 splice 模式）。
   * 返回删除后是否发生了快照整组移除（用于调用方修正遍历下标）。
   */
  private removeFileEntry(filePath: string, snapshotIndex: number): boolean {
    const snapshot = this.index.snapshots[snapshotIndex];
    if (!snapshot) return false;
    snapshot.files = snapshot.files.filter((f) => f.filePath !== filePath);
    this.dirty = true;
    if (snapshot.files.length === 0) {
      this.index.snapshots.splice(snapshotIndex, 1);
      return true;
    }
    return false;
  }

  /**
   * A. per-file 版本上限：当某文件历史条目数 > maxCheckpointsPerFile 时从最旧端删。
   * 删最旧条目前若它是 full 且后面还有依赖它的 diff，先重锚定下一个 diff 为 full。
   */
  private async evictPerFile(): Promise<void> {
    const max = this.config.maxCheckpointsPerFile;
    if (!max || max <= 0) return;

    for (const filePath of this.allTrackedFilePaths()) {
      // 循环删最旧，直到条目数 ≤ max（保留铁律 #1/#5：至少留最近若干个，且 ≥ /checkpoints 可见窗口由 max 保证）。
      let entries = this.collectFileEntries(filePath);
      while (entries.length > max) {
        const oldest = entries[0];
        if (oldest.file.type === "full") {
          // 先重锚定后续 diff；无法重锚定（它已是最新/唯一版本，或重建失败）则停止淘汰该文件。
          const ok = await this.reanchorFullForFile(filePath, oldest.snapshotIndex);
          if (!ok) break;
        }
        // 删最旧条目（重锚定已保证后续 diff 有 full 基点）。
        this.removeFileEntry(filePath, oldest.snapshotIndex);
        // 快照结构可能因整组移除而变化，重新收集。
        entries = this.collectFileEntries(filePath);
      }
    }
  }

  /**
   * B. 总量上限：当前 session index.json 序列化字节数超 maxTotalSizeMb 时，
   * 从最旧快照整组删（LRU=时间序），删到阈值下。删最旧段时对跨边界文件先重锚定。
   * 保留铁律 #5：保留窗口不小于 /checkpoints 可见的最近 10 条 + /undo 最近 1 条。
   */
  private async evictBySize(): Promise<void> {
    const maxBytes = this.config.maxTotalSizeMb * 1024 * 1024;
    if (!maxBytes || maxBytes <= 0) return;

    // 保留窗口下限：至少保留最近 MIN_KEEP 个快照，避免把用户可见/可 restore 的近期快照删掉。
    const MIN_KEEP = 11; // /checkpoints 显示最近 10 条 + /undo 最近 1 条

    let guard = 0;
    while (this.serializedSize() > maxBytes && this.index.snapshots.length > MIN_KEEP) {
      if (guard++ > 100000) break; // 防御性死循环阀
      // 待删的最旧快照（下标 0）。删前：对其中每个文件，若它是该文件当前 full 基点且后续有 diff 依赖，
      // 先重锚定后续 diff 为 full。
      const oldest = this.index.snapshots[0];
      if (!oldest) break;

      let blocked = false;
      for (const f of oldest.files) {
        if (f.type === "full") {
          const ok = await this.reanchorFullForFile(f.filePath, 0);
          if (!ok) {
            // 该文件的 full 无法重锚定（是最新/唯一版本）→ 不能删这个最旧快照，否则切链。
            blocked = true;
            break;
          }
        }
      }
      if (blocked) break; // 最旧快照不可删 → 停止总量淘汰（已尽力）。

      // 整组移除最旧快照。
      this.index.snapshots.shift();
      this.dirty = true;
    }
  }

  /** 计算当前 index 序列化后的字节数（与 saveIndex 落盘格式一致）。 */
  private serializedSize(): number {
    return Buffer.byteLength(JSON.stringify(this.index, null, 2), "utf-8");
  }

  /** 淘汰后重建 latestFullMap：文件路径 → 最新 full 快照 id（时间序最后一个 full）。 */
  private rebuildLatestFullMap(): void {
    const map: Record<string, string> = {};
    for (const snapshot of this.index.snapshots) {
      for (const f of snapshot.files) {
        if (f.type === "full") {
          map[f.filePath] = snapshot.id; // 后出现的覆盖，最终指向最新 full
        }
      }
    }
    this.index.latestFullMap = map;
  }

  /** 获取最后一个快照 */
  private getLastSnapshot(): Snapshot | null {
    if (this.index.snapshots.length === 0) return null;
    return this.index.snapshots[this.index.snapshots.length - 1];
  }

  /** 移除最后一个快照 */
  private removeLastSnapshot(): void {
    if (this.index.snapshots.length > 0) {
      this.index.snapshots.pop();
      this.dirty = true;
    }
  }

  /**
   * P1-G2b：从源会话继承 checkpoint 历史（`--fork-session` 用）。
   *
   * 背景（本次修复的真缺口）：分叉会话的 logical session id 是全新的，checkpoint 目录因此
   * 是空目录——新会话 `/undo` / `/restore` 够不到分叉前的任何编辑，方案 §3 的验收标准
   * 「新会话 /undo 能回退到分叉前的编辑」此前不成立。
   *
   * 实现选择：**深拷贝索引**而非软链/转读。快照的完整内容与 diff 都内联在 index.json 里
   * （见 Snapshot.content / .diff），没有旁挂的物理文件，所以一次索引拷贝就是完整继承；
   * 而拷贝（相对转读）让两个会话此后各自独立演进——新会话继续 snapshot / undo 不会
   * 反向污染源会话的回退历史，这是分叉语义的要求。
   *
   * 约束与边界：
   * - 仅在当前会话**尚无任何快照**时执行（刚 init 的分叉会话），否则视为误调用直接跳过，
   *   避免把源历史插进已有快照序列造成 id 冲突 / 时序错乱。
   * - `sessionId` 改写为当前会话，`nextId` 沿用源值（快照 id 不重排，保持 `/restore <ID>`
   *   在分叉前后指向同一个逻辑快照，用户的肌肉记忆和历史记录里的 id 仍然有效）。
   * - 源不存在 / 索引损坏 → 只告警，新会话退化为空 checkpoint（不阻断启动）。
   *
   * @param srcSessionId 源会话 id
   * @returns 继承到的快照条数（0 表示未继承）
   */
  async inheritFrom(srcSessionId: string): Promise<number> {
    const log = getLogger();
    if (!this.config.enabled) return 0;
    if (!srcSessionId || srcSessionId === this.sessionId) return 0;
    // 已有快照 → 不做插入式继承（防 id 冲突 / 时序错乱）
    if (this.index.snapshots.length > 0) {
      log.warn("CHECKPOINT", `继承跳过：当前会话已有 ${this.index.snapshots.length} 个快照，不做插入式继承`);
      return 0;
    }

    try {
      const srcIndexPath = join(sidPaths.checkpoints(srcSessionId), "index.json");
      if (!existsSync(srcIndexPath)) {
        log.info("CHECKPOINT", `源会话无 checkpoint 可继承: ${srcSessionId}`);
        return 0;
      }
      const parsed = JSON.parse(await Bun.file(srcIndexPath).text());
      // 源可能是旧格式（files 而非 snapshots）——复用既有迁移逻辑，继承后即为新格式。
      const srcIndex: CheckpointIndex = parsed.files && !parsed.snapshots
        ? this.migrateLegacyIndex(parsed as LegacyCheckpointIndex)
        : (parsed as CheckpointIndex);

      const snapshots = Array.isArray(srcIndex.snapshots) ? srcIndex.snapshots : [];
      if (snapshots.length === 0) {
        log.info("CHECKPOINT", `源会话 checkpoint 为空，无需继承: ${srcSessionId}`);
        return 0;
      }

      // 深拷贝：两会话此后独立演进，改一边不影响另一边（structuredClone 覆盖 diff 嵌套结构）。
      this.index = {
        sessionId: this.sessionId,
        createdAt: srcIndex.createdAt ?? Date.now(),
        nextId: typeof srcIndex.nextId === "number" ? srcIndex.nextId : snapshots.length + 1,
        snapshots: structuredClone(snapshots),
        latestFullMap: structuredClone(srcIndex.latestFullMap ?? {}),
      };
      this.dirty = true;
      await this.saveIndex();
      log.info(
        "CHECKPOINT",
        `已从源会话继承 checkpoint: ${srcSessionId} → ${this.sessionId}（${snapshots.length} 个快照，两会话此后独立演进）`,
      );
      return snapshots.length;
    } catch (e) {
      log.warn("CHECKPOINT", `checkpoint 继承失败（新会话退化为空回退历史，不阻断）: ${(e as Error)?.message}`);
      return 0;
    }
  }

  /** 保存索引到磁盘 */
  private async saveIndex(): Promise<void> {
    if (!this.dirty) return;

    const indexPath = join(this.baseDir, "index.json");
    await Bun.write(indexPath, JSON.stringify(this.index, null, 2));
    this.dirty = false;
  }

  /** 清理过期的其他会话目录 */
  private cleanupOldSessions(): void {
    const log = getLogger();
    const parentDir = sidPaths.checkpointsRoot();

    try {
      if (!existsSync(parentDir)) return;

      const sessions = readdirSync(parentDir);
      const now = Date.now();
      const maxAgeMs = this.config.maxAgeDays * 24 * 60 * 60 * 1000;
      const maxTotalBytes = this.config.maxTotalSizeMb * 1024 * 1024;

      // 存活会话（未过期、非当前）的 {目录, mtime, 大小}，用于后续按 LRU 真删。
      const survivors: Array<{ dir: string; name: string; mtimeMs: number; size: number }> = [];
      let totalSize = 0;

      for (const session of sessions) {
        if (session === this.sessionId) continue;

        const sessionDir = join(parentDir, session);
        try {
          const stat = statSync(sessionDir);
          if (!stat.isDirectory()) continue;

          // 检查是否过期
          if (now - stat.mtimeMs > maxAgeMs) {
            rmSync(sessionDir, { recursive: true, force: true });
            log.debug("CHECKPOINT", `清理过期会话: ${session}`);
            continue;
          }

          // 累计大小
          const size = this.getDirSize(sessionDir);
          totalSize += size;
          survivors.push({ dir: sessionDir, name: session, mtimeMs: stat.mtimeMs, size });
        } catch {
          // 忽略无法访问的目录
        }
      }

      // P1-2：总大小超限时真删（此前只 warn）。按 mtime LRU 删最旧的其他 session 目录，
      // 删到阈值下。当前 session（this.sessionId）永不在候选内（上面已 skip），由写时 evictBySize 自清。
      if (totalSize > maxTotalBytes) {
        survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧在前
        for (const s of survivors) {
          if (totalSize <= maxTotalBytes) break;
          try {
            rmSync(s.dir, { recursive: true, force: true });
            totalSize -= s.size;
            log.debug("CHECKPOINT", `总量超限清理最旧会话: ${s.name} (释放 ${(s.size / 1024 / 1024).toFixed(1)}MB)`);
          } catch {
            // 单个删除失败不影响其余
          }
        }
      }
    } catch {
      // 忽略清理错误
    }
  }

  /** 计算目录大小 */
  private getDirSize(dir: string): number {
    let size = 0;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        const filePath = join(dir, file);
        const stat = statSync(filePath);
        if (stat.isFile()) {
          size += stat.size;
        }
      }
    } catch {
      // 忽略
    }
    return size;
  }

  /** 获取当前会话的 checkpoint 统计 */
  getStats(): { fileCount: number; totalCheckpoints: number } {
    const uniqueFiles = new Set<string>();
    for (const snapshot of this.index.snapshots) {
      for (const file of snapshot.files) {
        uniqueFiles.add(file.filePath);
      }
    }
    return {
      fileCount: uniqueFiles.size,
      totalCheckpoints: this.index.snapshots.length,
    };
  }
}

/** 全局 CheckpointManager 实例（延迟初始化） */
let globalCheckpointManager: CheckpointManager | null = null;

/** 获取或创建全局 CheckpointManager */
export async function getCheckpointManager(
  sessionId: string,
  config?: CheckpointConfig,
): Promise<CheckpointManager> {
  if (!globalCheckpointManager || (globalCheckpointManager as any).sessionId !== sessionId) {
    globalCheckpointManager = new CheckpointManager(sessionId, config);
    await globalCheckpointManager.init();
  }
  return globalCheckpointManager;
}
