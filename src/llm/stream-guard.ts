/**
 * 流式超时保护共享层 — stream-guard.ts
 *
 * 对标 openai.ts 的 idle timeout + stall 日志，提供可复用的 AsyncGenerator 包装。
 * anthropic.ts 和未来的其他 provider 共用此层。
 *
 * 职责：
 * - idle timeout：无事件超过阈值后触发 onTimeout 回调中断流
 * - stall 告警：事件间隔超过 stallWarnMs 时记录 warning（不中断）
 * - 流统计：总事件数、TTFT、流总耗时
 * - 接入 RetryTelemetry：发出 stream_stall / stream_idle_timeout / stream_completed 事件
 */

import { getLogger } from "../debug/logger.ts";
import type { StreamTelemetrySignal } from "./types.ts";

export interface StreamGuardOptions {
  /** 无事件超时（毫秒）。超时后触发 onTimeout 回调中断流 */
  idleTimeoutMs: number;
  /** stall 告警阈值（毫秒）。超过此间隔记录 warning 但不中断。默认 30_000 */
  stallWarnMs?: number;
  /** provider 标签（日志用） */
  label: string;
  /** 中断回调（超时触发时执行，如 abort stream） */
  onTimeout?: () => void;
  /** 遥测回调（流内诊断事件） */
  onTelemetry?: (event: StreamGuardTelemetryEvent) => void;
}

/**
 * 流内诊断遥测事件。
 * 复用 types.ts 的 {@link StreamTelemetrySignal} 作为单一事实源，
 * 避免与 SendParams.onStreamTelemetry 的契约漂移。
 */
export type StreamGuardTelemetryEvent = StreamTelemetrySignal;

/**
 * 包装 AsyncIterable，加入 idle timeout + stall 告警 + 流统计。
 * 两个 provider 都可复用。
 */
export async function* guardedStream<T>(
  source: AsyncIterable<T>,
  opts: StreamGuardOptions,
): AsyncGenerator<T> {
  const { idleTimeoutMs, stallWarnMs = 30_000, label, onTimeout, onTelemetry } = opts;
  const log = getLogger();

  let totalEvents = 0;
  let lastEventTime = Date.now();
  const streamStartTime = lastEventTime;
  let firstEventTime: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let timedOut = false;

  const clearTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    lastEventTime = Date.now();
    idleTimer = setTimeout(() => {
      timedOut = true;
      log.warn(`LLM:${label}`, `流式空闲超时 ${idleTimeoutMs / 1000}s，中断`, { totalEvents });
      onTelemetry?.({ type: "stream_idle_timeout", provider: label.toLowerCase(), timeoutMs: idleTimeoutMs, totalEvents });
      onTimeout?.();
    }, idleTimeoutMs);
  };

  // stall 心跳：每 stallWarnMs 检查一次，如果期间无事件则告警
  stallTimer = setInterval(() => {
    const gap = Date.now() - lastEventTime;
    if (gap >= stallWarnMs) {
      log.warn(`LLM:${label}`, `事件间隔 ${(gap / 1000).toFixed(0)}s（stall）`, { totalEvents });
      onTelemetry?.({ type: "stream_stall", provider: label.toLowerCase(), gapMs: gap, totalEvents });
    }
  }, stallWarnMs);

  resetIdle();
  try {
    for await (const event of source) {
      if (timedOut) break;
      totalEvents++;
      if (!firstEventTime) firstEventTime = Date.now();
      resetIdle();
      yield event;
    }
  } finally {
    clearTimers();
    const elapsedMs = Date.now() - streamStartTime;
    const ttftMs = firstEventTime ? firstEventTime - streamStartTime : undefined;
    log.debug(`LLM:${label}`, `流结束`, { totalEvents, elapsedMs, ttftMs });
    onTelemetry?.({ type: "stream_completed", provider: label.toLowerCase(), totalEvents, elapsedMs, ttftMs });
  }
}
