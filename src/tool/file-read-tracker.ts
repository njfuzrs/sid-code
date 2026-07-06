/**
 * 文件读取追踪器
 * 记录哪些文件被 Read 过以及当时的 mtime，
 * Edit/Write 时校验必须先读后改，并检测外部修改
 */

import { statSync, readFileSync } from "fs";
import { resolve } from "path";

/** 文件读取记录 */
interface ReadRecord {
  path: string;
  readTime: number;  // 读取时的时间戳
  mtime: number;     // 读取时文件的 mtime
  lastAccessTime: number; // 最近一次访问（读/写/编辑）的时间戳（§2.1 post-compact 文件恢复用）
  /**
   * 是否只读取了文件的部分内容（offset/limit 分段读、或超默认行数被截断）。
   * 仅用于决定是否记录 content 快照（部分视图无完整内容，记 null）。
   *
   * ⚠️ 不再作为 edit/write 的拒绝依据（对齐 claude-code）：CC 的普通 read 从不因
   * offset/limit 置此标志，编辑安全性由 edit 自身「从磁盘重读全文 + old_string 精确
   * 串匹配（匹配不到即报错）」保证——模型改到未读区域本就不可能发生。曾据此拒绝会
   * 误杀「读全文 → 编辑 → 定向读定位 → 再编辑」这一改大文件的自然工作流。
   */
  isPartialView: boolean;
  /**
   * 读取时的文件内容（仅完整读取时记录，用于外部修改的内容比对兜底）。
   * mtime 变化不等于内容变化（touch / formatter 重写 / 云同步都会动 mtime），
   * 完整读取时用内容比对避免假"外部修改"误报。部分读取不记（无完整内容可比）。
   */
  content: string | null;
}

export class FileReadTracker {
  private readFiles = new Map<string, ReadRecord>();

  /**
   * 标记文件已被读取。
   *
   * @param mtime 读取时刻的文件 mtime
   * @param opts.isPartialView 是否只读了部分内容（offset/limit/截断）——默认 false（完整读取）
   * @param opts.content 完整读取时的文件内容（用于外部修改的内容比对兜底）——部分读取传 null/省略
   */
  markAsRead(
    filePath: string,
    mtime: number,
    opts?: { isPartialView?: boolean; content?: string | null },
  ): void {
    const resolved = resolve(filePath).normalize("NFC");
    const now = Date.now();
    const isPartialView = opts?.isPartialView ?? false;
    this.readFiles.set(resolved, {
      path: resolved,
      readTime: now,
      mtime,
      lastAccessTime: now,
      isPartialView,
      // 只在完整读取时保留内容（部分视图无完整内容可比，且避免为超大文件常驻内存）
      content: !isPartialView ? (opts?.content ?? null) : null,
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
    return this.validateFresh(filePath, "编辑");
  }

  /**
   * 验证文件是否可以安全覆盖写入（write 工具用）。
   * 语义与 validateForEdit 完全一致——覆盖已有文件同样需要「先完整读取 + 无外部修改」，
   * 否则会静默冲掉未读区域或他人改动。仅错误文案按「写入/覆盖」措辞。
   *
   * ⚠️ 调用方只应在「文件已存在」时调用；新建文件（写入即创建）无需先读，不要调用此方法。
   */
  validateForWrite(filePath: string): string | null {
    return this.validateFresh(filePath, "覆盖写入");
  }

  /**
   * 「先读后改」新鲜度校验的单一事实源，供 edit/write 共用，杜绝两条护栏逻辑漂移。
   *   1. 从没读过 → 拒绝
   *   2. 读后被外部修改（mtime 变且内容确实不同）→ 拒绝
   *
   * ⚠️ 不再校验 partial-view（对齐 claude-code）：曾据 isPartialView 拒绝部分读取后的
   * 编辑，会误杀「读全文 → 编辑 → 定向读定位 → 再编辑」的自然工作流。编辑安全性由 edit
   * 自身「从磁盘重读全文 + old_string 精确串匹配」保证，无需此门禁。
   * @param action 错误文案里的动作词（"编辑" / "覆盖写入"）
   */
  private validateFresh(filePath: string, action: string): string | null {
    const resolved = resolve(filePath).normalize("NFC");
    const record = this.readFiles.get(resolved);

    if (!record) {
      return `文件必须先用 read 工具读取后才能${action}: ${filePath}`;
    }

    // 检查文件是否在读取后被外部修改
    try {
      const currentMtime = statSync(resolved).mtimeMs;
      if (currentMtime !== record.mtime) {
        // mtime 变了不代表内容变了（touch / formatter 重写 / 云同步都会动 mtime）。
        // 完整读取且记录了内容时，做一次内容比对兜底，避免假"外部修改"误报。
        if (record.content !== null) {
          try {
            const currentContent = readFileSync(resolved, "utf-8");
            if (currentContent === record.content) {
              return null; // 内容一致，仅 mtime 变化，安全放行
            }
          } catch {
            // 读取失败则退回按 mtime 判定（保守报"已修改"）
          }
        }
        return `文件自上次读取后已被外部修改，请重新读取后再${action}: ${filePath}`;
      }
    } catch {
      // 文件可能已被删除，让后续操作处理
    }

    return null;
  }

  /** 更新文件的 mtime 与内容快照（写入/编辑后调用） */
  updateMtime(filePath: string, newContent?: string): void {
    const resolved = resolve(filePath).normalize("NFC");
    const record = this.readFiles.get(resolved);
    if (record) {
      try {
        record.mtime = statSync(resolved).mtimeMs;
        record.readTime = Date.now();
        record.lastAccessTime = Date.now(); // §2.1：写/编辑也算一次访问
        // 编辑后内容已知 → 同步刷新内容快照，否则下次 validateForEdit 的内容比对
        // 会拿旧内容比对，把"自己刚写的新内容"误判为外部修改。
        // 编辑必产出完整新内容，故写入后一定是完整视图。
        if (newContent !== undefined) {
          record.content = newContent;
          record.isPartialView = false;
        }
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
