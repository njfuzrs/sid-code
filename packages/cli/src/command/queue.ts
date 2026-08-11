/**
 * 命令队列
 *
 * 核心设计：
 * - 三级优先级：now > next > later
 * - 单一队列，所有待处理输入统一管理
 * - 通过回调通知订阅者（UI 层感知队列变化）
 *
 * 用途：模型运行时用户输入排队等待；系统通知（后台任务）低优先级入队，
 * 不会饿死用户输入。
 */

export type QueuePriority = "now" | "next" | "later";

export interface QueuedCommand {
  /** 用户输入的原始文本 */
  value: string;
  /** 输入模式：prompt（普通文本）/ bash（shell 命令）/ slash（斜杠命令） */
  mode: "prompt" | "bash" | "slash";
  /** 优先级，默认 "next" */
  priority: QueuePriority;
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

export class CommandQueue {
  private queue: QueuedCommand[] = [];
  private listeners = new Set<() => void>();

  /** 入队（用户输入，默认 next 优先级） */
  enqueue(cmd: Omit<QueuedCommand, "priority"> & { priority?: QueuePriority }): void {
    this.queue.push({ ...cmd, priority: cmd.priority ?? "next" });
    this.notify();
  }

  /** 入队系统通知（默认 later 优先级） */
  enqueueNotification(cmd: Omit<QueuedCommand, "priority"> & { priority?: QueuePriority }): void {
    this.queue.push({ ...cmd, priority: cmd.priority ?? "later" });
    this.notify();
  }

  /** 出队：取优先级最高的命令（同优先级按入队顺序 FIFO） */
  dequeue(): QueuedCommand | undefined {
    if (this.queue.length === 0) return undefined;

    let bestIdx = 0;
    let bestPriority = PRIORITY_ORDER[this.queue[0].priority];
    for (let i = 1; i < this.queue.length; i++) {
      const p = PRIORITY_ORDER[this.queue[i].priority];
      if (p < bestPriority) {
        bestIdx = i;
        bestPriority = p;
      }
    }

    const [dequeued] = this.queue.splice(bestIdx, 1);
    this.notify();
    return dequeued;
  }

  /** 查看队首（不移除） */
  peek(): QueuedCommand | undefined {
    if (this.queue.length === 0) return undefined;
    return this.queue.reduce((best, cmd) =>
      PRIORITY_ORDER[cmd.priority] < PRIORITY_ORDER[best.priority] ? cmd : best,
    );
  }

  /** 清空队列 */
  clear(): void {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.notify();
  }

  get length(): number {
    return this.queue.length;
  }

  /** 快照（只读） */
  snapshot(): readonly QueuedCommand[] {
    return [...this.queue];
  }

  /** 订阅队列变化，返回取消订阅函数 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
