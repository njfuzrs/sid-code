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

export interface StreamGuardOptions<T = unknown> {
  /** 无事件超时（毫秒）。超时后触发 onTimeout 回调中断流 */
  idleTimeoutMs: number;
  /**
   * T2：业务内容进展超时（毫秒）。只在"有意义的业务内容"到达时重置。
   *
   * 与 idleTimeoutMs 的关键区别：idle timer 对**任何事件**（含 Anthropic 的 ping
   * keep-alive）都 reset，因此高频 ping 会永远续命 idle timer、90s idle 超时永不触发；
   * content progress timer 只对 `isContentProgress(event)` 返回 true 的事件 reset，
   * 因此能识破"只有 ping、无真内容"的僵死流。
   *
   * 不传则不启用该层（保持向后兼容，只有 idle timeout 生效）。
   */
  contentProgressTimeoutMs?: number;
  /**
   * T2：判断一个事件是否算"业务内容进展"。仅在传了 contentProgressTimeoutMs 时使用。
   * 例如 Anthropic：`(e) => e.type === 'content_block_delta' || e.type === 'message_delta'`
   * ——ping / message_start / content_block_start 都不算进展。
   */
  isContentProgress?: (event: T) => boolean;
  /** stall 告警阈值（毫秒）。超过此间隔记录 warning 但不中断。默认 30_000 */
  stallWarnMs?: number;
  /** provider 标签（日志用） */
  label: string;
  /**
   * 中断回调（超时触发时执行，如 abort stream）。
   * T2：入参 layer 区分是哪一层超时触发（idle / content_progress），
   * 便于调用方按层记录不同的可观测性事件；旧调用方忽略入参即可（向后兼容）。
   */
  onTimeout?: (layer?: "idle" | "content_progress") => void;
  /** 遥测回调（流内诊断事件） */
  onTelemetry?: (event: StreamGuardTelemetryEvent) => void;
  /** A5: 外部 abort signal，流消费中检查以支持用户中断穿透 */
  signal?: AbortSignal;
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
  opts: StreamGuardOptions<T>,
): AsyncGenerator<T> {
  const {
    idleTimeoutMs,
    contentProgressTimeoutMs,
    isContentProgress,
    stallWarnMs = 30_000,
    label,
    onTimeout,
    onTelemetry,
    signal,
  } = opts;
  const log = getLogger();

  // T2：只有同时传了阈值 + 判定函数才启用 content progress 层。
  const contentProgressEnabled =
    typeof contentProgressTimeoutMs === "number" &&
    contentProgressTimeoutMs > 0 &&
    typeof isContentProgress === "function";

  let totalEvents = 0;
  let lastEventTime = Date.now();
  const streamStartTime = lastEventTime;
  let firstEventTime: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let contentTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let timedOut = false;

  const clearTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (contentTimer) { clearTimeout(contentTimer); contentTimer = null; }
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    lastEventTime = Date.now();
    idleTimer = setTimeout(() => {
      timedOut = true;
      log.warn(`LLM:${label}`, `流式空闲超时 ${idleTimeoutMs / 1000}s，中断`, { totalEvents });
      onTelemetry?.({ type: "stream_idle_timeout", provider: label.toLowerCase(), timeoutMs: idleTimeoutMs, totalEvents });
      onTimeout?.("idle");
    }, idleTimeoutMs);
  };

  // T2：content progress timer——独立于 idle timer，只在业务内容到达时重置。
  // ping / message_start 等 keep-alive 事件不会重置它，因此"只有 ping、无真内容"
  // 的僵死流会在 contentProgressTimeoutMs 后被识破并中断。
  const resetContentProgress = () => {
    if (!contentProgressEnabled) return;
    if (contentTimer) clearTimeout(contentTimer);
    contentTimer = setTimeout(() => {
      timedOut = true;
      log.warn(
        `LLM:${label}`,
        `业务内容进展超时 ${contentProgressTimeoutMs! / 1000}s（可能只有 keep-alive/ping，无实际内容），中断`,
        { totalEvents },
      );
      onTelemetry?.({
        type: "stream_content_progress_timeout",
        provider: label.toLowerCase(),
        timeoutMs: contentProgressTimeoutMs!,
        totalEvents,
      });
      onTimeout?.("content_progress");
    }, contentProgressTimeoutMs!);
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
  resetContentProgress(); // 启动 content progress 计时（未启用时空转）
  try {
    for await (const event of source) {
      if (timedOut) break;
      // A5 纵深防御：流消费中检查 signal，支持用户中断穿透
      if (signal?.aborted) break;
      totalEvents++;
      if (!firstEventTime) firstEventTime = Date.now();
      // idle timer 对任何事件都 reset（保护"TCP 连接彻底断开"场景，含 ping）
      resetIdle();
      // content progress timer 只对"业务进展"事件 reset（ping 不续命）
      if (contentProgressEnabled && isContentProgress!(event)) {
        resetContentProgress();
      }
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
