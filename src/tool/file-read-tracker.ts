/**
 * 文件读取追踪器
 * 记录哪些文件被 Read 过以及当时的 mtime，
 * Edit/Write 时校验必须先读后改，并检测外部修改
 */

import { statSync } from "fs";
import { resolve } from "path";

/** 文件读取记录 */
interface ReadRecord {
  path: string;
  readTime: number;  // 读取时的时间戳
  mtime: number;     // 读取时文件的 mtime
  lastAccessTime: number; // 最近一次访问（读/写/编辑）的时间戳（§2.1 post-compact 文件恢复用）
}

export class FileReadTracker {
  private readFiles = new Map<string, ReadRecord>();

  /** 标记文件已被读取 */
  markAsRead(filePath: string, mtime: number): void {
    const resolved = resolve(filePath).normalize("NFC");
    const now = Date.now();
    this.readFiles.set(resolved, {
      path: resolved,
      readTime: now,
      mtime,
      lastAccessTime: now,
    });
  }

  /** 检查文件是否已被读取过 */
  hasBeenRead(filePath: string): boolean {
    return this.readFiles.has(resolve(filePath).normalize("NFC"));
  }

  /**
   * §2.1：按 lastAccessTime 降序返回最近访问的文件路径（最多 limit 个）。
   * 用于压缩后主动恢复模型最近在操作的文件内容，避免压缩后"断片"重读。
   */
  getRecentFiles(limit: number = 5): string[] {
    return Array.from(this.readFiles.values())
      .sort((a, b) => b.lastAccessTime - a.lastAccessTime)
      .slice(0, limit)
      .map((r) => r.path);
  }

  /**
   * §2.1：返回记录的 mtime（读取时刻的文件 mtime），用于 post-compact 恢复时比对磁盘是否已变更。
   * 未追踪过返回 null。
   */
  getRecordedMtime(filePath: string): number | null {
    const record = this.readFiles.get(resolve(filePath).normalize("NFC"));
    return record ? record.mtime : null;
  }

  /**
   * 验证文件是否可以安全编辑
   * 返回 null 表示可以编辑，返回字符串表示错误原因
   */
  validateForEdit(filePath: string): string | null {
    const resolved = resolve(filePath).normalize("NFC");
    const record = this.readFiles.get(resolved);

    if (!record) {
      return `文件必须先用 read 工具读取后才能编辑: ${filePath}`;
    }

    // 检查文件是否在读取后被外部修改
    try {
      const currentMtime = statSync(resolved).mtimeMs;
      if (currentMtime !== record.mtime) {
        return `文件自上次读取后已被外部修改，请重新读取: ${filePath}`;
      }
    } catch {
      // 文件可能已被删除，让后续操作处理
    }

    return null;
  }

  /** 更新文件的 mtime（写入/编辑后调用） */
  updateMtime(filePath: string): void {
    const resolved = resolve(filePath).normalize("NFC");
    const record = this.readFiles.get(resolved);
    if (record) {
      try {
        record.mtime = statSync(resolved).mtimeMs;
        record.readTime = Date.now();
        record.lastAccessTime = Date.now(); // §2.1：写/编辑也算一次访问
      } catch {
        // 忽略
      }
    }
  }

  /** 清空所有记录 */
  clear(): void {
    this.readFiles.clear();
  }
}
