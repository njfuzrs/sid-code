/**
 * 文件状态缓存
 * 基于 LRU 策略的文件状态管理，替代 FileReadTracker
 * 支持内容比对、部分视图保护、内存上限
 */

import { statSync, readFileSync } from "fs";
import { resolve } from "path";

/** 文件状态记录 */
export interface FileState {
  /** 读取时的文件内容（用于内容比对） */
  content: string;
  /** 读取时的文件 mtime */
  mtime: number;
  /** 读取的起始行偏移（undefined = 从头开始） */
  offset?: number;
  /** 读取的行数限制（undefined = 读到末尾） */
  limit?: number;
  /** 是否为部分视图 */
  isPartialView?: boolean;
}

/** 路径规范化（大小写不敏感，macOS/Windows） */
function normalizePath(p: string): string {
  return resolve(p).toLowerCase();
}

/**
 * LRU 缓存条目
 * 双向链表节点 + Map 实现 O(1) 的 get/set/evict
 */
interface CacheEntry {
  key: string;
  value: FileState;
  size: number;
  prev: CacheEntry | null;
  next: CacheEntry | null;
}

export class FileStateCache {
  private map = new Map<string, CacheEntry>();
  private head: CacheEntry | null = null;  // 最近使用
  private tail: CacheEntry | null = null;  // 最久未使用
  private currentSize = 0;
  private maxSize: number;

  constructor(maxSizeBytes: number = 25 * 1024 * 1024) {
    this.maxSize = maxSizeBytes;
  }

  /** 估算条目内存占用 */
  private estimateSize(state: FileState): number {
    return state.content.length * 2 + 200;  // UTF-16 + 固定开销
  }

  /** 将节点移到链表头部（最近使用） */
  private moveToHead(entry: CacheEntry): void {
    if (entry === this.head) return;

    // 从当前位置摘除
    if (entry.prev) entry.prev.next = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    if (entry === this.tail) this.tail = entry.prev;

    // 插入头部
    entry.prev = null;
    entry.next = this.head;
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;
  }

  /** 淘汰最久未使用的条目，直到腾出足够空间 */
  private evict(neededSize: number): void {
    while (this.tail && this.currentSize + neededSize > this.maxSize) {
      const evicted = this.tail;
      this.tail = evicted.prev;
      if (this.tail) {
        this.tail.next = null;
      } else {
        this.head = null;
      }
      this.map.delete(evicted.key);
      this.currentSize -= evicted.size;
    }
  }

  /** 记录文件读取 */
  set(path: string, state: FileState): void {
    const key = normalizePath(path);
    const size = this.estimateSize(state);

    // 如果已存在，先移除旧条目
    const existing = this.map.get(key);
    if (existing) {
      this.currentSize -= existing.size;
      existing.value = state;
      existing.size = size;
      this.currentSize += size;
      this.moveToHead(existing);
      return;
    }

    // 淘汰直到有空间
    this.evict(size);

    // 创建新条目
    const entry: CacheEntry = {
      key,
      value: state,
      size,
      prev: null,
      next: this.head,
    };
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;

    this.map.set(key, entry);
    this.currentSize += size;
  }

  /** 获取文件状态 */
  get(path: string): FileState | undefined {
    const key = normalizePath(path);
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.moveToHead(entry);
    return entry.value;
  }

  /** 检查文件是否已读取 */
  has(path: string): boolean {
    return this.map.has(normalizePath(path));
  }

  /**
   * 验证文件是否可以安全编辑
   * 返回 null 表示可以编辑，返回字符串表示错误原因
   */
  validateForEdit(path: string): string | null {
    const state = this.get(path);

    // 1. 必须先读取
    if (!state) {
      return `文件必须先用 read 工具读取后才能编辑: ${path}`;
    }

    // 2. 部分视图不允许编辑
    if (state.isPartialView) {
      return `只读取了文件的部分内容，无法安全编辑。请先完整读取文件: ${path}`;
    }

    // 3. 检测外部修改
    try {
      const resolved = resolve(path);
      const currentMtime = statSync(resolved).mtimeMs;

      if (currentMtime > state.mtime) {
        // mtime 变了，但内容可能没变（如 touch 命令）
        // 只有在完整读取的情况下才做内容比对
        if (state.offset === undefined && state.limit === undefined) {
          const currentContent = readFileSync(resolved, "utf-8");
          if (currentContent === state.content) {
            // 内容相同，仅 mtime 变化，允许编辑
            return null;
          }
        }
        return `文件自上次读取后已被外部修改，请重新读取: ${path}`;
      }
    } catch {
      // 文件可能已被删除，让后续操作处理
    }

    return null;
  }

  /** 编辑后更新缓存 */
  updateAfterEdit(path: string, newContent: string): void {
    try {
      const resolved = resolve(path);
      const mtime = statSync(resolved).mtimeMs;
      this.set(path, {
        content: newContent,
        mtime,
        offset: undefined,
        limit: undefined,
        isPartialView: false,
      });
    } catch {
      // 忽略
    }
  }

  /** 更新文件的 mtime（写入后调用，兼容旧 FileReadTracker 接口） */
  updateMtime(path: string): void {
    const state = this.get(path);
    if (state) {
      try {
        const resolved = resolve(path);
        state.mtime = statSync(resolved).mtimeMs;
      } catch {
        // 忽略
      }
    }
  }

  /** 检查文件是否已被读取过（兼容旧 FileReadTracker 接口） */
  hasBeenRead(path: string): boolean {
    return this.has(path);
  }

  /** 标记文件已被读取（兼容旧 FileReadTracker 接口） */
  markAsRead(filePath: string, mtime: number): void {
    try {
      const resolved = resolve(filePath);
      const content = readFileSync(resolved, "utf-8");
      this.set(filePath, { content, mtime });
    } catch {
      // 文件不存在或读取失败，仅记录 mtime
      this.set(filePath, { content: "", mtime });
    }
  }

  /** 清空所有记录 */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.currentSize = 0;
  }

  /** 当前缓存大小（字节） */
  size(): number {
    return this.currentSize;
  }

  /** 缓存条目数 */
  count(): number {
    return this.map.size;
  }
}
