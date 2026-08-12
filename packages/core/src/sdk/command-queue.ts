/**
 * 命令队列：优先级排序 + 批量合并
 *
 * SDK 模式下外部调用者可能连续投递多条消息（IDE 批量编辑、CI 多步骤）。
 * 队列负责：
 * - 优先级排序（now > next > later，稳定排序保证同优先级 FIFO）
 * - 批量合并（连续同 workload 的 prompt 合并为一次 LLM 调用，省 token）
 *
 * 对齐 Claude Code 的优先级队列设计（spec §4.6）。
 */

export interface QueuedCommand {
  /** 命令模式 */
  mode: "prompt" | "meta" | "notification";
  /** 命令内容 */
  value: string;
  /** 唯一标识 */
  uuid?: string;
  /** 优先级 */
  priority: "now" | "next" | "later";
  /** 工作负载标签（用于批量合并匹配） */
  workload?: string;
  /** 是否为元消息（不记录到 transcript） */
  isMeta?: boolean;
}

const PRIORITY_ORDER: Record<QueuedCommand["priority"], number> = {
  now: 0,
  next: 1,
  later: 2,
};

export class CommandQueue {
  private queue: QueuedCommand[] = [];
  /** 单调递增序号，保证同优先级稳定 FIFO（Array.sort 在跨引擎下不保证稳定） */
  private seq = 0;
  private seqMap = new WeakMap<QueuedCommand, number>();

  /** 入队 */
  enqueue(command: QueuedCommand): void {
    this.seqMap.set(command, this.seq++);
    this.queue.push(command);
    this.queue.sort((a, b) => {
      const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (byPriority !== 0) return byPriority;
      // 同优先级按入队顺序
      return (this.seqMap.get(a) ?? 0) - (this.seqMap.get(b) ?? 0);
    });
  }

  /** 出队（可选过滤器） */
  dequeue(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | undefined {
    const idx = filter ? this.queue.findIndex(filter) : 0;
    if (idx < 0 || idx >= this.queue.length) return undefined;
    return this.queue.splice(idx, 1)[0];
  }

  /** 查看队首（不移除） */
  peek(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | undefined {
    return filter ? this.queue.find(filter) : this.queue[0];
  }

  /**
   * 批量出队：连续可合并的 prompt 命令合并为一条
   * 非 prompt 命令直接返回（不合并）
   */
  dequeueBatch(): QueuedCommand | undefined {
    const head = this.dequeue();
    if (!head || head.mode !== "prompt") return head;

    const batch: QueuedCommand[] = [head];
    while (this.canBatchWith(head, this.peek())) {
      batch.push(this.dequeue()!);
    }

    if (batch.length === 1) return head;

    // 合并多条 prompt 为一条；uuid 取最后一条有 uuid 的命令
    return {
      ...head,
      value: batch.map((c) => c.value).join("\n\n"),
      uuid: batch.filter((c) => c.uuid).pop()?.uuid ?? head.uuid,
    };
  }

  /** 判断 next 是否可与 head 批量合并 */
  private canBatchWith(head: QueuedCommand, next: QueuedCommand | undefined): boolean {
    return (
      next !== undefined &&
      next.mode === "prompt" &&
      next.workload === head.workload &&
      next.isMeta === head.isMeta
    );
  }

  /** 队列是否为空 */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** 队列长度 */
  size(): number {
    return this.queue.length;
  }
}
