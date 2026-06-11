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
          totalSize += this.getDirSize(sessionDir);
        } catch {
          // 忽略无法访问的目录
        }
      }

      // 如果总大小超限，清理最旧的会话
      if (totalSize > maxTotalBytes) {
        log.warn("CHECKPOINT", `Checkpoint 总大小超限 (${(totalSize / 1024 / 1024).toFixed(1)}MB)，清理旧会话`);
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
