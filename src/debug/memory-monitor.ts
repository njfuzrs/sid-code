/**
 * 内存监控
 * 长会话场景下检测内存泄漏，提供诊断数据
 */

import { getLogger } from './logger.ts';

export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;     // V8 堆已用（字节）
  heapTotal: number;    // V8 堆总量
  rss: number;          // 常驻集大小
  external: number;     // 外部内存（Buffer 等）
  arrayBuffers: number; // ArrayBuffer 内存
}

export class MemoryMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private highWaterMark: number = 0;           // RSS 高水位（字节）
  private readonly growthThreshold = 0.1;      // 10% 增长才记录
  private readonly checkIntervalMs = 30_000;   // 30 秒检查一次
  private snapshots: MemorySnapshot[] = [];
  private readonly maxSnapshots = 100;         // 最多保留 100 条

  start(): void {
    if (this.intervalId) return;

    // 记录初始快照
    this.takeSnapshot();

    this.intervalId = setInterval(() => {
      this.checkAndRecord();
    }, this.checkIntervalMs);

    // 不阻止进程退出
    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private checkAndRecord(): void {
    const mem = process.memoryUsage();
    const currentRss = mem.rss;

    // 首次或增长超过阈值时记录
    if (this.highWaterMark === 0 ||
        currentRss > this.highWaterMark * (1 + this.growthThreshold)) {
      this.highWaterMark = currentRss;
      this.takeSnapshot();

      getLogger().debug('MEMORY', `高水位更新: RSS=${formatBytes(currentRss)}, Heap=${formatBytes(mem.heapUsed)}`);
    }
  }

  private takeSnapshot(): void {
    const mem = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    };

    this.snapshots.push(snapshot);

    // 超限时丢弃旧数据
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.maxSnapshots);
    }
  }

  /** 获取当前内存快照 */
  getCurrentSnapshot(): MemorySnapshot {
    const mem = process.memoryUsage();
    return {
      timestamp: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    };
  }

  /** 获取历史快照（用于趋势分析） */
  getSnapshots(): MemorySnapshot[] {
    return [...this.snapshots];
  }

  /** 生成内存报告 */
  getReport(): string {
    const current = this.getCurrentSnapshot();
    const lines = [
      `当前内存使用:`,
      `  RSS:          ${formatBytes(current.rss)}`,
      `  Heap Used:    ${formatBytes(current.heapUsed)}`,
      `  Heap Total:   ${formatBytes(current.heapTotal)}`,
      `  External:     ${formatBytes(current.external)}`,
      `  ArrayBuffers: ${formatBytes(current.arrayBuffers)}`,
      `  高水位 RSS:   ${formatBytes(this.highWaterMark)}`,
      `  快照数量:     ${this.snapshots.length}`,
    ];

    // 如果有历史数据，显示增长趋势
    if (this.snapshots.length >= 2) {
      const first = this.snapshots[0];
      const growth = current.rss - first.rss;
      const elapsed = (current.timestamp - first.timestamp) / 1000 / 60;
      lines.push(`  RSS 增长:     ${growth > 0 ? '+' : ''}${formatBytes(growth)} (${elapsed.toFixed(1)}分钟)`);
    }

    return lines.join('\n');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 全局单例
let globalMonitor: MemoryMonitor | null = null;

export function getMemoryMonitor(): MemoryMonitor {
  if (!globalMonitor) globalMonitor = new MemoryMonitor();
  return globalMonitor;
}
