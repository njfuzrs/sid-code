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
}

export class FileReadTracker {
  private readFiles = new Map<string, ReadRecord>();

  /** 标记文件已被读取 */
  markAsRead(filePath: string, mtime: number): void {
    const resolved = resolve(filePath).normalize("NFC");
    this.readFiles.set(resolved, {
      path: resolved,
      readTime: Date.now(),
      mtime,
    });
  }

  /** 检查文件是否已被读取过 */
  hasBeenRead(filePath: string): boolean {
    return this.readFiles.has(resolve(filePath).normalize("NFC"));
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
