/**
 * 队列处理器
 *
 * 在模型空闲时消费队列中的命令。
 *
 * 触发条件（由 UI 层的 useQueueProcessor 保证，全部满足才调用 processNext）：
 * 1. 模型空闲（isModelActive === false）
 * 2. 无交互式 UI 在显示（如 /config 对话框）
 * 3. 队列非空
 *
 * 处理策略：每次取出优先级最高的一条交给应用层执行（runInput）。
 * 斜杠/bash 命令可能改变系统状态，单独逐条处理而非批量合并。
 */

import type { CommandQueue } from "./queue.ts";

export interface QueueProcessorDeps {
  queue: CommandQueue;
  /** 执行一条输入，由应用层提供（内部走 InputRouter / onUserInput） */
  runInput: (input: string) => void;
}

export class QueueProcessor {
  constructor(private deps: QueueProcessorDeps) {}

  /**
   * 尝试处理队列中的下一个命令
   * @returns true 表示处理了一个命令，false 表示队列为空
   */
  processNext(): boolean {
    const cmd = this.deps.queue.dequeue();
    if (!cmd) return false;
    this.deps.runInput(cmd.value);
    return true;
  }
}
