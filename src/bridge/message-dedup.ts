/**
 * 消息去重 — 环形缓冲区
 *
 * 对标 Claude Code 的 BoundedUUIDSet：
 * - 固定容量，自动驱逐最旧条目
 * - O(1) 查询和插入
 * - 避免无限增长导致内存泄漏
 */
export class BoundedUUIDSet {
  private readonly capacity: number;
  private readonly ring: (string | undefined)[];
  private readonly set = new Set<string>();
  private writeIdx = 0;

  constructor(capacity: number = 10000) {
    if (capacity <= 0) throw new Error("BoundedUUIDSet 容量必须为正数");
    this.capacity = capacity;
    this.ring = new Array(capacity).fill(undefined);
  }

  /** 添加 UUID（满时驱逐最旧条目） */
  add(uuid: string): void {
    if (this.set.has(uuid)) return; // 已存在，避免重复占用环形槽位

    const evicted = this.ring[this.writeIdx];
    if (evicted !== undefined) {
      this.set.delete(evicted);
    }
    this.ring[this.writeIdx] = uuid;
    this.set.add(uuid);
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
  }

  /** 是否包含 UUID */
  has(uuid: string): boolean {
    return this.set.has(uuid);
  }

  /** 当前条目数 */
  get size(): number {
    return this.set.size;
  }
}
