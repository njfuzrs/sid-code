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
  /**
   * 批量合并时被合并进来的**全部** uuid（按入队顺序，只在合并 ≥2 条时出现）。
   * `uuid` 只能放一个值（保留最后一条，向后兼容），其余的必须另有落点，
   * 否则宿主「发了 A、等 A 的回应」会永久等待——A 已经被合进这一轮了，但输出里找不到它。
   */
  mergedUuids?: string[];
}

const PRIORITY_ORDER: Record<QueuedCommand["priority"], number> = {
  now: 0,
  next: 1,
  later: 2,
};

export class CommandQueue {
  private queue: QueuedCommand[] = [];

  /**
   * 入队：插到「最后一个优先级 ≤ 它的命令」之后，同优先级天然 FIFO。
   *
   * 以前是 push + 全量 sort + WeakMap 记入队序号，理由是「Array.sort 跨引擎不保证稳定」——
   * ES2019 起规范要求稳定，这个理由已不成立。而那套序号有个隐式契约：查不到序号的对象
   * （比如 dequeueBatch 合出来的新对象被重新入队）按 `?? 0` 算，会插到同优先级**最前面**。
   * 按位置插入不需要任何旁路状态，也就没有「查不到」这一格。
   */
  enqueue(command: QueuedCommand): void {
    const rank = PRIORITY_ORDER[command.priority];
    let i = this.queue.length;
    while (i > 0 && PRIORITY_ORDER[this.queue[i - 1].priority] > rank) i--;
    this.queue.splice(i, 0, command);
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

    // 合并多条 prompt 为一条。uuid 保留最后一条有 uuid 的（既有契约，宿主可能按它对齐），
    // 全部 uuid 进 mergedUuids——单个 uuid 字段装不下「这一轮回应了哪几条」。
    const uuids = batch.map((c) => c.uuid).filter((u): u is string => !!u);
    return {
      ...head,
      value: batch.map((c) => c.value).join("\n\n"),
      uuid: uuids[uuids.length - 1] ?? head.uuid,
      ...(uuids.length > 0 ? { mergedUuids: uuids } : {}),
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
