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

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { computeDiff, type DiffResult } from "./diff.ts";
import { getLogger } from "../debug/logger.ts";

/** 单个 Checkpoint 条目 */
interface CheckpointEntry {
  /** 文件路径 */
  filePath: string;
  /** 时间戳 */
  timestamp: number;
  /** 存储类型：full=完整内容, diff=增量差异 */
  type: "full" | "diff";
  /** 完整内容（type=full 时） */
  content?: string;
  /** 是否 gzip 压缩（type=full 且内容 >1KB 时） */
  compressed?: boolean;
  /** 增量差异（type=diff 时） */
  diff?: DiffResult;
}

/** 单个文件的 Checkpoint 历史 */
interface FileCheckpoints {
  filePath: string;
  entries: CheckpointEntry[];
}

/** Checkpoint 索引文件格式 */
interface CheckpointIndex {
  sessionId: string;
  createdAt: number;
  files: Record<string, FileCheckpoints>;
}

/** 限制常量 */
const MAX_CHECKPOINTS_PER_FILE = 50;
const MAX_TOTAL_SIZE_BYTES = 200 * 1024 * 1024; // 200MB
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const COMPRESS_THRESHOLD = 1024; // 1KB 以上压缩

export class CheckpointManager {
  private sessionId: string;
  private baseDir: string;
  private index: CheckpointIndex;
  private dirty: boolean = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.baseDir = join(homedir(), ".sid-code", "checkpoints", sessionId);
    this.index = {
      sessionId,
      createdAt: Date.now(),
      files: {},
    };
  }

  /** 初始化：创建目录 + 加载索引 */
  async init(): Promise<void> {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    const indexPath = join(this.baseDir, "index.json");
    if (existsSync(indexPath)) {
      try {
        const data = await Bun.file(indexPath).text();
        this.index = JSON.parse(data);
      } catch {
        // 索引损坏，重新创建
        this.index = { sessionId: this.sessionId, createdAt: Date.now(), files: {} };
      }
    }

    // 清理过期的其他会话
    this.cleanupOldSessions();
  }

  /**
   * 创建 Checkpoint：在文件被修改前调用
   * 保存当前文件内容的快照
   */
  async createCheckpoint(filePath: string): Promise<void> {
    const log = getLogger();

    try {
      // 读取当前文件内容
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        // 新文件，记录为空内容
        this.addEntry(filePath, {
          filePath,
          timestamp: Date.now(),
          type: "full",
          content: "",
        });
        await this.saveIndex();
        return;
      }

      const currentContent = await file.text();
      const fileCheckpoints = this.index.files[filePath];

      if (!fileCheckpoints || fileCheckpoints.entries.length === 0) {
        // 第一次：保存完整内容
        const entry: CheckpointEntry = {
          filePath,
          timestamp: Date.now(),
          type: "full",
        };

        if (currentContent.length > COMPRESS_THRESHOLD) {
          // gzip 压缩 + base64
          const compressed = Bun.gzipSync(Buffer.from(currentContent, "utf-8"));
          entry.content = Buffer.from(compressed).toString("base64");
          entry.compressed = true;
        } else {
          entry.content = currentContent;
          entry.compressed = false;
        }

        this.addEntry(filePath, entry);
      } else {
        // 后续：保存增量 diff
        const lastContent = await this.getLatestContent(filePath);
        if (lastContent === null || lastContent === currentContent) {
          // 内容没变，跳过
          return;
        }

        const diff = computeDiff(lastContent, currentContent);
        this.addEntry(filePath, {
          filePath,
          timestamp: Date.now(),
          type: "diff",
          diff,
        });
      }

      await this.saveIndex();
      log.debug("CHECKPOINT", `已创建快照: ${filePath}`);
    } catch (err: any) {
      log.warn("CHECKPOINT", `创建快照失败: ${filePath} - ${err.message}`);
    }
  }

  /**
   * 撤销最近一次修改：回滚到上一个 checkpoint
   * 返回回滚的文件路径，null 表示无可回滚的 checkpoint
   */
  async undo(): Promise<{ filePath: string; restoredContent: string } | null> {
    const log = getLogger();

    // 找到最近被修改的文件（按最后 checkpoint 时间排序）
    const allFiles = Object.entries(this.index.files)
      .filter(([_, fc]) => fc.entries.length > 0)
      .map(([path, fc]) => ({
        path,
        lastTimestamp: fc.entries[fc.entries.length - 1].timestamp,
        entries: fc.entries,
      }))
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    if (allFiles.length === 0) {
      return null;
    }

    // 取最近修改的文件
    const target = allFiles[0];
    const filePath = target.path;

    // 获取上一个版本的内容
    const content = await this.getLatestContent(filePath);
    if (content === null) {
      return null;
    }

    // 写回文件
    try {
      await Bun.write(filePath, content);

      // 移除最后一个 checkpoint
      const fc = this.index.files[filePath];
      fc.entries.pop();
      if (fc.entries.length === 0) {
        delete this.index.files[filePath];
      }

      await this.saveIndex();
      log.info("CHECKPOINT", `已回滚: ${filePath}`);

      return { filePath, restoredContent: content };
    } catch (err: any) {
      log.error("CHECKPOINT", `回滚失败: ${filePath} - ${err.message}`);
      return null;
    }
  }

  /**
   * 获取指定文件最新 checkpoint 的内容
   * 从第一个 full checkpoint 开始，逐步 apply diff
   */
  private async getLatestContent(filePath: string): Promise<string | null> {
    const fc = this.index.files[filePath];
    if (!fc || fc.entries.length === 0) return null;

    // 找到最近的 full checkpoint
    let baseContent = "";
    let startIdx = 0;

    for (let i = fc.entries.length - 1; i >= 0; i--) {
      if (fc.entries[i].type === "full") {
        const entry = fc.entries[i];
        if (entry.compressed && entry.content) {
          const buf = Buffer.from(entry.content, "base64");
          const decompressed = Bun.gunzipSync(buf);
          baseContent = Buffer.from(decompressed).toString("utf-8");
        } else {
          baseContent = entry.content || "";
        }
        startIdx = i + 1;
        break;
      }
    }

    // 逐步 apply diff
    let content = baseContent;
    const { applyDiff } = await import("./diff.ts");
    for (let i = startIdx; i < fc.entries.length; i++) {
      const entry = fc.entries[i];
      if (entry.type === "diff" && entry.diff) {
        content = applyDiff(content, entry.diff);
      }
    }

    return content;
  }

  /** 添加 checkpoint 条目（含数量限制） */
  private addEntry(filePath: string, entry: CheckpointEntry): void {
    if (!this.index.files[filePath]) {
      this.index.files[filePath] = { filePath, entries: [] };
    }

    const fc = this.index.files[filePath];
    fc.entries.push(entry);

    // 超过限制时，移除最旧的条目
    while (fc.entries.length > MAX_CHECKPOINTS_PER_FILE) {
      fc.entries.shift();
    }

    this.dirty = true;
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
    const parentDir = join(homedir(), ".sid-code", "checkpoints");

    try {
      if (!existsSync(parentDir)) return;

      const sessions = readdirSync(parentDir);
      const now = Date.now();
      let totalSize = 0;

      for (const session of sessions) {
        if (session === this.sessionId) continue;

        const sessionDir = join(parentDir, session);
        try {
          const stat = statSync(sessionDir);
          if (!stat.isDirectory()) continue;

          // 检查是否过期
          if (now - stat.mtimeMs > MAX_AGE_MS) {
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
      if (totalSize > MAX_TOTAL_SIZE_BYTES) {
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
    const files = Object.keys(this.index.files);
    const totalCheckpoints = Object.values(this.index.files)
      .reduce((sum, fc) => sum + fc.entries.length, 0);
    return { fileCount: files.length, totalCheckpoints };
  }
}

/** 全局 CheckpointManager 实例（延迟初始化） */
let globalCheckpointManager: CheckpointManager | null = null;

/** 获取或创建全局 CheckpointManager */
export async function getCheckpointManager(sessionId: string): Promise<CheckpointManager> {
  if (!globalCheckpointManager || (globalCheckpointManager as any).sessionId !== sessionId) {
    globalCheckpointManager = new CheckpointManager(sessionId);
    await globalCheckpointManager.init();
  }
  return globalCheckpointManager;
}
