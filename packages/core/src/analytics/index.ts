// src/analytics/index.ts
// 零依赖事件 API——纯内存队列,延迟绑定 Sink
//
// 设计原则:这个文件不 import 任何其他模块,避免导入链污染。
// 类型定义全部内联。任何模块导入 logEvent 都不会触发额外的模块加载。
//
// 对应 spec 17 §3.1。

// --- 类型定义(内联,不从外部导入)---

/** 强制开发者确认值不包含代码或文件路径 */
export type VerifiedNotCodeOrFilepaths = string & { __brand: "verified_not_code" };

/** 标记为 PII 的值,仅流向特权后端 */
export type VerifiedPIITagged = string & { __brand: "verified_pii" };

/** 事件元数据值类型——故意不允许裸 string,字符串必须显式标记 */
export type EventMetadataValue =
  | boolean
  | number
  | undefined
  | VerifiedNotCodeOrFilepaths
  | VerifiedPIITagged;

export type EventMetadata = Record<string, EventMetadataValue>;

interface QueuedEvent {
  eventName: string;
  metadata: EventMetadata;
  timestamp: number;
}

export interface AnalyticsSink {
  logEvent(eventName: string, metadata: EventMetadata): void;
}

// --- 状态 ---

/** 启动期事件队列上限,防止 Sink 长时间未绑定时无限增长 */
const MAX_QUEUE_SIZE = 1000;

const eventQueue: QueuedEvent[] = [];
let sink: AnalyticsSink | null = null;

// --- 公共 API ---

/**
 * 记录一个分析事件。Sink 未就绪时暂存到队列。
 * 永不抛错——遥测是旁路,绝不影响主流程。
 */
export function logEvent(eventName: string, metadata: EventMetadata): void {
  try {
    if (sink === null) {
      // 队列溢出保护:丢弃最旧的事件
      if (eventQueue.length >= MAX_QUEUE_SIZE) {
        eventQueue.shift();
      }
      eventQueue.push({ eventName, metadata, timestamp: Date.now() });
      return;
    }
    sink.logEvent(eventName, metadata);
  } catch {
    // 遥测失败静默吞掉
  }
}

/**
 * 绑定 Sink,排空队列。幂等——多次调用安全,只有首次生效。
 * 异步排空,不阻塞启动路径。
 */
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) return;
  sink = newSink;

  if (eventQueue.length > 0) {
    const queued = [...eventQueue];
    eventQueue.length = 0;
    // 微任务排空,不阻塞启动
    queueMicrotask(() => {
      for (const event of queued) {
        try {
          sink!.logEvent(event.eventName, event.metadata);
        } catch {
          // 单条失败不影响后续
        }
      }
    });
  }
}

/** 是否已绑定 Sink(测试与诊断用) */
export function hasAnalyticsSink(): boolean {
  return sink !== null;
}

/** 当前暂存队列长度(测试与诊断用) */
export function getQueuedEventCount(): number {
  return eventQueue.length;
}

/**
 * 重置事件 API 状态(仅供测试使用)。
 * 清空 Sink 绑定与队列,使后续 attachAnalyticsSink 可重新生效。
 */
export function __resetAnalyticsForTest(): void {
  sink = null;
  eventQueue.length = 0;
}
