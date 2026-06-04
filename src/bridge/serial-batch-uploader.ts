/**
 * 串行批处理上传器
 *
 * 对标 Claude Code 的 SerialBatchEventUploader：
 * - 最多 1 个 POST 在途 + 1 个待处理批次
 * - 新事件合并到待处理批次
 * - 失败时指数退避 + 无限重试
 * - 背压：enqueue() 在队列满时等待
 */
import { getLogger } from "../debug/logger.ts";

export class SerialBatchUploader<T> {
  private inflight: T[] | null = null;
  private pending: T[] = [];
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly postFn: (batch: T[]) => Promise<void>;
  private consecutiveFailures = 0;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private draining = false;
  private stopped = false;

  constructor(options: {
    postFn: (batch: T[]) => Promise<void>;
    maxBatchSize?: number;
    maxQueueSize?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  }) {
    this.postFn = options.postFn;
    this.maxBatchSize = options.maxBatchSize ?? 500;
    this.maxQueueSize = options.maxQueueSize ?? 10000;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
  }

  /** 入队（背压：队列满时等待） */
  async enqueue(items: T[]): Promise<void> {
    while (this.pending.length >= this.maxQueueSize && !this.stopped) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.stopped) return;
    this.pending.push(...items);
    void this.drain();
  }

  /** 刷新所有待处理消息 */
  async flush(): Promise<void> {
    while ((this.pending.length > 0 || this.inflight !== null) && !this.stopped) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 停止上传（放弃在途与待处理） */
  stop(): void {
    this.stopped = true;
    this.pending = [];
    this.inflight = null;
  }

  /** 待处理数量（调试用） */
  get pendingCount(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.inflight !== null || this.stopped) return;
    if (this.pending.length === 0) return;

    this.draining = true;
    try {
      while (this.pending.length > 0 && !this.stopped) {
        // 取出一批（不超过 maxBatchSize）
        const batch = this.pending.splice(0, this.maxBatchSize);
        this.inflight = batch;

        let delivered = false;
        while (!delivered && !this.stopped) {
          try {
            await this.postFn(batch);
            delivered = true;
            this.consecutiveFailures = 0;
          } catch (err: any) {
            this.consecutiveFailures++;
            const delay = Math.min(
              this.baseDelayMs * Math.pow(2, this.consecutiveFailures - 1),
              this.maxDelayMs,
            );
            getLogger().warn(
              "BRIDGE",
              `批次上传失败（第 ${this.consecutiveFailures} 次），${delay}ms 后重试: ${err.message}`,
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        this.inflight = null;
      }
    } finally {
      this.draining = false;
    }
  }
}
