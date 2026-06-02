/**
 * 队列处理 Hook
 *
 * 监听队列变化和模型状态，在模型空闲且无对话框时自动消费队列。
 *
 * 触发条件（全部满足才处理）：
 * 1. 模型空闲（!isModelActive）
 * 2. 无交互式对话框（!hasActiveDialog）
 * 3. 队列非空
 */

import { useEffect, useState } from "react";
import type { CommandQueue } from "../../command/queue.ts";
import type { QueueProcessor } from "../../command/queue-processor.ts";

export function useQueueProcessor(
  queue: CommandQueue,
  processor: QueueProcessor,
  isModelActive: boolean,
  hasActiveDialog: boolean,
): number {
  const [queueLength, setQueueLength] = useState(queue.length);

  // 订阅队列长度变化
  useEffect(() => {
    setQueueLength(queue.length);
    return queue.subscribe(() => setQueueLength(queue.length));
  }, [queue]);

  // 满足条件时消费一条（消费后队列变化会再次触发本 effect）
  useEffect(() => {
    if (isModelActive) return;
    if (hasActiveDialog) return;
    if (queueLength === 0) return;
    processor.processNext();
  }, [queueLength, isModelActive, hasActiveDialog, processor]);

  return queueLength;
}
