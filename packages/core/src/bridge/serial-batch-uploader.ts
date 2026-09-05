/**
 * 串行批处理上传器
 *
 * 对标 Claude Code 的 SerialBatchEventUploader：
 * - 最多 1 个 POST 在途 + 1 个待处理批次
 * - 新事件合并到待处理批次
 * - 失败时指数退避重试，**超过上限则丢弃该批**（D10）
 * - 背压：enqueue() 在队列满时等待
 * - flush() 有**硬性时限**（D9）
 *
 * ⚠️ 两条曾同源的缺陷，改动理由写在这里以免被"简化"掉：
 *
 * **D9（关停挂起，实测确认）**：`flush()` 原本无条件 `while` 等到队列空。
 * 而 `drain()` 在 post 失败时无限重试同一批，且断连时 `sendBatch()` **必然抛错**
 * （`readyState !== OPEN` 就 throw）。于是断连 + 队列非空 ⇒ `inflight` 永不清空
 * ⇒ `flush()` 永不返回 ⇒ `BridgeCore.stop()` 永不返回。实际表现是"Ctrl+C 后卡一下
 * 然后退出"，因为 `app.ts` 的信号处理器有 **1.5 秒强制 exit 兜底** ——
 * **兜底掩盖了两件真实损害**：① 那 1.5 秒里 `runShutdownSequence()` /
 * `mcpManager.closeAll()` 排在 `runner.stop()` 之后，没跑完就被强杀；
 * ② 退出码 130 看起来像"用户中断"，掩盖了"我们自己挂住了"。
 *
 * **D10（无丢弃上限）**：`consecutiveFailures` 原本**只用于计算退避延迟、从不用于
 * 放弃**，退避上限 8s ⇒ 最终是每 8 秒重试同一批，永远。运行期后果是一批卡住时
 * 后面所有消息都排在它后面，队列涨到 `maxQueueSize` 后 `enqueue()` 开始背压等待，
 * 整个转发链路停摆。
 *
 * **丢弃必须留计数**（本仓判据：降级动作必须留下计数）。没有计数的丢弃是
 * 完全不可观测的行为 —— 线上出问题时无法回答"有没有丢消息"，只能猜。
 */
import { getLogger } from "../debug/logger.ts";

/** 轮询间隔：flush 等待与背压等待共用 */
const POLL_INTERVAL_MS = 50;

export class SerialBatchUploader<T> {
  private inflight: T[] | null = null;
  private pending: T[] = [];
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly postFn: (batch: T[]) => Promise<void>;
  private consecutiveFailures = 0;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly flushTimeoutMs: number;
  private draining = false;
  private stopped = false;

  /** 累计丢弃批次数（D10：降级必须可观测） */
  private droppedBatches = 0;
  /** 累计丢弃条目数 —— 批次数不够用：一批可能是 1 条也可能是 500 条 */
  private droppedItems = 0;

  constructor(options: {
    postFn: (batch: T[]) => Promise<void>;
    maxBatchSize?: number;
    maxQueueSize?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /**
     * 同一批连续失败多少次后丢弃（D10）。默认 8：以 baseDelay 500ms / maxDelay 8s
     * 的退避算，8 次约 30 秒 —— 短于任何人的耐心，长于绝大多数瞬时抖动 + 一次重连。
     */
    maxConsecutiveFailures?: number;
    /**
     * `flush()` 的默认时限（D9）。默认 2000ms：必须**明显小于** app.ts 那个
     * 1.5s 强杀兜底之后的收尾预算，否则修了这里还是会被强杀截断。
     */
    flushTimeoutMs?: number;
  }) {
    this.postFn = options.postFn;
    this.maxBatchSize = options.maxBatchSize ?? 500;
    this.maxQueueSize = options.maxQueueSize ?? 10000;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 8;
    this.flushTimeoutMs = options.flushTimeoutMs ?? 2000;
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

  /**
   * 刷新所有待处理消息，**最多等 timeoutMs**（D9）。
   *
   * @returns true = 真的排空了；false = 到点了还没排空（调用方据此决定是否记日志）
   *
   * 语义是"尽力发完，但有上限"——关停时无限等待不是"更可靠"，是**挂死**。
   */
  async flush(timeoutMs: number = this.flushTimeoutMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (this.pending.length > 0 || this.inflight !== null) {
      if (this.stopped) return true; // stop() 已清空队列，视为完成
      if (Date.now() >= deadline) {
        getLogger().warn(
          "BRIDGE",
          `flush 超时（${timeoutMs}ms）：仍有 ${this.pending.length} 条待发` +
            `${this.inflight ? " + 1 批在途" : ""}，放弃等待`,
        );
        return false;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return true;
  }

  /** 停止上传（放弃在途与待处理） */
  stop(): void {
    this.stopped = true;
    // 放弃的也算丢弃：否则"关停时丢了多少"这个问题答不出来
    this.droppedItems += this.pending.length + (this.inflight?.length ?? 0);
    if (this.pending.length > 0) this.droppedBatches++;
    if (this.inflight) this.droppedBatches++;
    this.pending = [];
    this.inflight = null;
  }

  /** 待处理数量（调试用） */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 累计丢弃批次数（D10 的可观测性出口） */
  get droppedBatchCount(): number {
    return this.droppedBatches;
  }

  /** 累计丢弃条目数 */
  get droppedItemCount(): number {
    return this.droppedItems;
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

            // D10：超过上限丢弃这一批，继续处理后面的（有损但不卡死）。
            // 计数必须留下 —— 静默丢消息比卡住更难排查。
            if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
              this.droppedBatches++;
              this.droppedItems += batch.length;
              this.consecutiveFailures = 0;
              getLogger().error(
                "BRIDGE",
                `批次上传连续失败 ${this.maxConsecutiveFailures} 次，丢弃该批` +
                  `（${batch.length} 条）；累计丢弃 ${this.droppedBatches} 批 / ` +
                  `${this.droppedItems} 条。最后一次错误: ${err.message}`,
              );
              break; // 跳出重试循环，inflight 在外层被清空后继续下一批
            }

            const delay = Math.min(
              this.baseDelayMs * Math.pow(2, this.consecutiveFailures - 1),
              this.maxDelayMs,
            );
            getLogger().warn(
              "BRIDGE",
              `批次上传失败（第 ${this.consecutiveFailures}/${this.maxConsecutiveFailures} 次），` +
                `${delay}ms 后重试: ${err.message}`,
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
