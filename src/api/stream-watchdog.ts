/**
 * 流式看门狗（Watchdog）
 *
 * 职责（对标 Claude Code 的流式监控）：
 * - 包装任意 AsyncIterable 流，添加停滞检测与超时中止
 * - 采集流式性能指标：TTFB / 总耗时 / 停滞次数 / 停滞总时长 / 事件数
 * - 50% 超时发警告，100% 超时触发中止回调
 *
 * 设计为通用流包装器，不耦合具体 Provider。
 * 相比 stream-processor.ts 现有的简单心跳（30s 无数据中断），
 * 本模块提供分级告警 + 停滞计数 + 结构化指标。
 */

/** 流式性能指标 */
export interface StreamMetrics {
  /** Time-To-First-Byte（首个事件延迟，毫秒；无事件为 -1） */
  ttfbMs: number;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
  /** 停滞次数（相邻事件间隔超过阈值的次数） */
  stallCount: number;
  /** 停滞总时长（毫秒） */
  totalStallTimeMs: number;
  /** 事件总数 */
  eventCount: number;
  /** 最后一个事件类型（若事件带 type 字段） */
  lastEventType: string;
}

/** 看门狗配置 */
export interface WatchdogConfig {
  /** 空闲超时（默认 90 秒） */
  idleTimeoutMs?: number;
  /** 停滞阈值（相邻事件间隔超过此值视为停滞，默认 30 秒） */
  stallThresholdMs?: number;
  /** 检查间隔（默认 5 秒） */
  checkIntervalMs?: number;
  /** 50% 超时警告回调 */
  onWarning?: (metrics: StreamMetrics) => void;
  /** 100% 超时中止回调（应触发底层 AbortController） */
  onTimeout?: (metrics: StreamMetrics) => void;
  /** 停滞事件回调 */
  onStall?: (stallDurationMs: number, metrics: StreamMetrics) => void;
  /** 时间源（可注入，便于测试） */
  now?: () => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_STALL_THRESHOLD_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;

/**
 * 用看门狗包装一个流。
 * 透传所有事件，同时在后台监控停滞与超时。
 * 超时由 onTimeout 回调负责中止底层流（通常 abort()），看门狗本身只观测不强杀。
 */
export async function* withWatchdog<T>(
  stream: AsyncIterable<T>,
  config: WatchdogConfig = {},
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const now = config.now ?? Date.now;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const stallThresholdMs = config.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  const startTime = now();
  let lastEventTime = startTime;
  let firstEventTime = -1;
  let stallCount = 0;
  let totalStallTimeMs = 0;
  let eventCount = 0;
  let warningFired = false;
  let lastEventType = "";

  const getMetrics = (): StreamMetrics => ({
    ttfbMs: firstEventTime >= 0 ? firstEventTime - startTime : -1,
    totalDurationMs: now() - startTime,
    stallCount,
    totalStallTimeMs,
    eventCount,
    lastEventType,
  });

  const checkTimer = setInterval(() => {
    const idleMs = now() - lastEventTime;
    if (!warningFired && idleMs > idleTimeoutMs * 0.5) {
      warningFired = true;
      config.onWarning?.(getMetrics());
    }
    if (idleMs > idleTimeoutMs) {
      config.onTimeout?.(getMetrics());
    }
  }, checkIntervalMs);

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;

      const t = now();
      const gap = t - lastEventTime;

      // 停滞检测（仅在已收到至少一个事件后）
      if (eventCount > 0 && gap > stallThresholdMs) {
        stallCount++;
        totalStallTimeMs += gap;
        config.onStall?.(gap, getMetrics());
      }

      if (firstEventTime < 0) firstEventTime = t;
      lastEventTime = t;
      eventCount++;
      warningFired = false; // 收到事件后重置警告状态

      if (event && typeof event === "object" && "type" in event) {
        lastEventType = String((event as { type: unknown }).type);
      }

      yield event;
    }
  } finally {
    clearInterval(checkTimer);
  }
}

/**
 * 采集流式指标但不中止（轻量观测模式）。
 * 返回 [包装后的流, 取指标函数]，调用方可在流结束后读取指标。
 */
export function meteredStream<T>(
  stream: AsyncIterable<T>,
  now: () => number = Date.now,
): { stream: AsyncGenerator<T>; getMetrics: () => StreamMetrics } {
  const startTime = now();
  let firstEventTime = -1;
  let lastEventTime = startTime;
  let eventCount = 0;
  let stallCount = 0;
  let totalStallTimeMs = 0;
  let lastEventType = "";
  const STALL = DEFAULT_STALL_THRESHOLD_MS;

  const getMetrics = (): StreamMetrics => ({
    ttfbMs: firstEventTime >= 0 ? firstEventTime - startTime : -1,
    totalDurationMs: (firstEventTime >= 0 ? lastEventTime : now()) - startTime,
    stallCount,
    totalStallTimeMs,
    eventCount,
    lastEventType,
  });

  async function* gen(): AsyncGenerator<T> {
    for await (const event of stream) {
      const t = now();
      const gap = t - lastEventTime;
      if (eventCount > 0 && gap > STALL) {
        stallCount++;
        totalStallTimeMs += gap;
      }
      if (firstEventTime < 0) firstEventTime = t;
      lastEventTime = t;
      eventCount++;
      if (event && typeof event === "object" && "type" in event) {
        lastEventType = String((event as { type: unknown }).type);
      }
      yield event;
    }
  }

  return { stream: gen(), getMetrics };
}
