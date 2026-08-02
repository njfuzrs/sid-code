/**
 * Retry Telemetry 结构化埋点
 *
 * Phase 3.2：对标 claude-code 的 logEvent 埋点体系，提供结构化的重试事件记录。
 * 用于可观测性：追踪重试次数、降级频率、529 丢弃率、max_tokens 调整次数。
 *
 * 使用方式：
 * - fallback.ts 通过 FallbackConfig.onTelemetry 回调接收事件
 * - 上层（app.ts / CLI）可对接日志系统、监控平台
 */
import { getLogger } from "../debug/logger.ts";

/** 重试 Telemetry 事件类型 */
export interface RetryTelemetryEvent {
  /** 事件类型 */
  type:
    | "retry"
    | "fallback"
    | "529_dropped"
    | "max_tokens_adjust"
    | "persistent_retry_wait"
    | "auth_refresh"
    // 流内诊断事件（由 stream-guard.ts 产生）
    | "stream_stall"
    | "stream_idle_timeout"
    | "stream_content_progress_timeout"
    | "stream_overall_timeout"
    | "stream_completed";
  /** 模型名 */
  model: string;
  /** 重试尝试次数（1-based） */
  attempt?: number;
  /** 退避延迟（毫秒） */
  delayMs?: number;
  /** 错误描述 */
  error?: string;
  /** Provider 名称 */
  provider?: string;
  /** 重试阶段：connection / stream */
  phase?: "connection" | "stream";
  /**
   * §6.3 重复开流成因遥测：本次"重新获取流"的结构化原因。
   *
   * 旧实现只记 error.message 字符串，无法在遥测层面区分重开成因。本字段按优先级记录：
   * - 超时类：idle_timeout / content_progress_timeout / fallback_stream_timeout
   *   （从 stream-observer snapshot 的 timeoutsFired 取最近触发的超时层）
   * - 非超时类：network_error / overloaded / empty_response / request_timeout 等
   *   （取自 classified.reason）
   *
   * 这是 §2.7 "同一轮重复开流"观测盲区的根因定位钥匙——回放会话时可据此判断
   * 重复开流是 idle 超时、内容进展超时、还是网络抖动导致。
   */
  reopenReason?: string;
  /** 降级目标模型 */
  fallbackModel?: string;
  /** 查询来源（后台 529 丢弃时） */
  querySource?: string;
  /**
   * B4：发起方 agent 标识（子代理隔离与归因）。
   *
   * 为什么 querySource 不够：它只到"类别"粒度（`agent:builtin` / `agent:custom`），
   * 6 个并行子代理的 querySource 完全相同。于是"哪个子代理重试了几次"这个问题
   * 只能得到"内置子代理一共重试了 37 次"——无法区分是一路撞限流撞了 37 次，
   * 还是 6 路各撞 6 次。前者该查那个模型/那个任务，后者是全局限流，修法完全不同。
   *
   * 主循环调用不带此字段（保持事件形状不变）。
   */
  agentId?: string;
  /** max_tokens 调整：原始值 */
  originalTokens?: number;
  /** max_tokens 调整：新值 */
  adjustedTokens?: number;
  // ── 流内诊断字段（stream_stall / stream_idle_timeout / stream_completed）──
  /** stall 间隔（毫秒） */
  gapMs?: number;
  /** 超时阈值（毫秒） */
  timeoutMs?: number;
  /** 总事件数 */
  totalEvents?: number;
  /** 流总耗时（毫秒） */
  elapsedMs?: number;
  /** 首 token 延迟（毫秒） */
  ttftMs?: number;
}

// ─── 全局遥测观察者（B4：让子代理侧的重试事件真正落轨迹） ───

let _observer: ((event: RetryTelemetryEvent) => void) | null = null;

/**
 * 注册全局重试遥测观察者（由 app.ts 在启动时注入，写入 events.jsonl）。
 *
 * B4 / §七 F7：为什么需要它。`FallbackConfig.onTelemetry` 只在 `app.ts:745` 那一个
 * ModelFallback 实例上接线，而子代理走 `streamWithResilience` **每次调用新建**漏斗实例，
 * 从不传 onTelemetry —— 于是"给遥测加 agentId"这件事本身会变成一个 F7 型死能力：
 * 字段加了、埋点带上了，但子代理的事件根本没有消费方，落不到 events.jsonl。
 *
 * 采用模块级观察者而非逐层透传回调，是沿用本仓既有形态
 * （`side-call-sink.ts` 的 `setSideCostObserver` / `gateway-pricing.ts` 的
 * `setGatewayPricingObserver`）：避免 llm 层反向依赖 trace 层，也避免在
 * agentic-loop → sub-agent → app 这条链上逐层加参数。
 */
export function setRetryTelemetryObserver(
  fn: ((event: RetryTelemetryEvent) => void) | null,
): void {
  _observer = fn;
}

/**
 * 分发一条重试遥测事件到全局观察者。
 *
 * 由 `fallback.ts` 的 `emitTelemetry` 在调用 per-instance 回调之外**额外**调用：
 * per-instance 回调保留（主循环靠它），全局观察者补上所有未接线的漏斗实例。
 * 主循环因此会经由两条路径各发一次 —— `emitTelemetry` 侧已做去重（见其注释）。
 */
export function dispatchRetryTelemetry(event: RetryTelemetryEvent): void {
  if (!_observer) return;
  try {
    _observer(event);
  } catch {
    // 遥测不应影响主流程
  }
}

/**
 * 默认的 Telemetry 处理器：通过 debug logger 记录。
 * 生产环境可替换为对接监控系统（如 Prometheus / Datadog）。
 */
export function defaultTelemetryHandler(event: RetryTelemetryEvent): void {
  const log = getLogger();

  switch (event.type) {
    case "retry":
      log.info("TELEMETRY", `[retry] ${event.model} phase=${event.phase} attempt=${event.attempt} delay=${event.delayMs}ms reopen=${event.reopenReason ?? "N/A"} error=${event.error}`);
      break;

    case "fallback":
      log.warn("TELEMETRY", `[fallback] ${event.model} → ${event.fallbackModel} error=${event.error}`);
      break;

    case "529_dropped":
      log.info("TELEMETRY", `[529_dropped] ${event.model} source=${event.querySource}`);
      break;

    case "max_tokens_adjust":
      log.info("TELEMETRY", `[max_tokens_adjust] ${event.model} ${event.originalTokens} → ${event.adjustedTokens}`);
      break;

    case "persistent_retry_wait":
      log.info("TELEMETRY", `[persistent_retry_wait] ${event.model} delay=${event.delayMs}ms`);
      break;

    case "auth_refresh":
      log.info("TELEMETRY", `[auth_refresh] ${event.model} error=${event.error}`);
      break;

    case "stream_stall":
      log.warn("TELEMETRY", `[stream_stall] provider=${event.provider} gap=${event.gapMs}ms events=${event.totalEvents}`);
      break;

    case "stream_idle_timeout":
      log.warn("TELEMETRY", `[stream_idle_timeout] provider=${event.provider} timeout=${event.timeoutMs}ms events=${event.totalEvents}`);
      break;

    case "stream_content_progress_timeout":
      log.warn("TELEMETRY", `[stream_content_progress_timeout] provider=${event.provider} timeout=${event.timeoutMs}ms events=${event.totalEvents}`);
      break;

    case "stream_overall_timeout":
      log.warn("TELEMETRY", `[stream_overall_timeout] provider=${event.provider} timeout=${event.timeoutMs}ms events=${event.totalEvents}`);
      break;

    case "stream_completed":
      log.info("TELEMETRY", `[stream_completed] provider=${event.provider} events=${event.totalEvents} elapsed=${event.elapsedMs}ms ttft=${event.ttftMs ?? "N/A"}ms`);
      break;
  }
}
