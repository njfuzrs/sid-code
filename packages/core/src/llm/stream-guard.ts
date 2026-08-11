/**
 * 流式超时保护共享层 — stream-guard.ts
 *
 * @deprecated 已升级为 {@link ./stream-lifecycle.ts} 的 StreamLifecycle 统一抽象（T7）。
 * 本文件保留为**向后兼容 wrapper**：`guardedStream` 直接 delegate 到 `streamLifecycle`，
 * 行为完全等价（idle timeout + content progress timeout + stall 告警）。新代码请直接
 * 使用 `createStreamLifecycle` / `streamLifecycle`，可额外获得 Layer 3 请求级整体超时。
 *
 * 渐进替换策略（见 roadmap §十二 决策表）：先并存验证，1-2 版本后删除本兼容层。
 * 现有 anthropic.ts / provider-conformance.test.ts / stream-guard-content-progress.test.ts
 * 仍通过本文件的 guardedStream 入口，delegate 后 yield 序列逐事件等价。
 */

import { streamLifecycle } from "./stream-lifecycle.ts";
import type { StreamLifecycleOptions } from "./stream-lifecycle.ts";
import type { StreamTelemetrySignal } from "./types.ts";

export interface StreamGuardOptions<T = unknown> {
  /** 无事件超时（毫秒）。超时后触发 onTimeout 回调中断流 */
  idleTimeoutMs: number;
  /**
   * T2：业务内容进展超时（毫秒）。只在"有意义的业务内容"到达时重置。
   * 不传则不启用该层（保持向后兼容，只有 idle timeout 生效）。
   */
  contentProgressTimeoutMs?: number;
  /**
   * T2：判断一个事件是否算"业务内容进展"。仅在传了 contentProgressTimeoutMs 时使用。
   */
  isContentProgress?: (event: T) => boolean;
  /** stall 告警阈值（毫秒）。超过此间隔记录 warning 但不中断。默认 30_000 */
  stallWarnMs?: number;
  /** provider 标签（日志用） */
  label: string;
  /**
   * 中断回调（超时触发时执行，如 abort stream）。
   * 入参 layer 区分是哪一层超时触发（idle / content_progress），旧调用方忽略入参即可。
   */
  onTimeout?: (layer?: "idle" | "content_progress") => void;
  /** 遥测回调（流内诊断事件） */
  onTelemetry?: (event: StreamGuardTelemetryEvent) => void;
  /** A5: 外部 abort signal，流消费中检查以支持用户中断穿透 */
  signal?: AbortSignal;
}

/**
 * 流内诊断遥测事件。
 * 复用 types.ts 的 {@link StreamTelemetrySignal} 作为单一事实源。
 */
export type StreamGuardTelemetryEvent = StreamTelemetrySignal;

/**
 * @deprecated 使用 {@link ./stream-lifecycle.ts} 的 `streamLifecycle` / `createStreamLifecycle`。
 *
 * 包装 AsyncIterable，加入 idle timeout + content progress timeout + stall 告警。
 * 现直接 delegate 到 streamLifecycle，行为完全等价（不启用 Layer 3 overall timeout，
 * 保持与旧版逐事件一致）。
 */
export async function* guardedStream<T>(
  source: AsyncIterable<T>,
  opts: StreamGuardOptions<T>,
): AsyncGenerator<T> {
  // 归一化到 StreamLifecycleOptions：guardedStream 的 onTimeout 只发 idle/content_progress
  // 两层（不启用 overall），因此这里不传 overallTimeoutMs，onTimeout 入参类型天然兼容。
  const lifecycleOpts: StreamLifecycleOptions<T> = {
    idleTimeoutMs: opts.idleTimeoutMs,
    contentProgressTimeoutMs: opts.contentProgressTimeoutMs,
    isContentProgress: opts.isContentProgress,
    stallWarnMs: opts.stallWarnMs,
    label: opts.label,
    signal: opts.signal,
    onTelemetry: opts.onTelemetry,
    // overall 层未启用，onTimeout 只会收到 idle / content_progress，与旧签名等价转发
    onTimeout: opts.onTimeout
      ? (layer) => opts.onTimeout!(layer === "overall" ? "idle" : layer)
      : undefined,
  };
  yield* streamLifecycle(source, lifecycleOpts);
}
