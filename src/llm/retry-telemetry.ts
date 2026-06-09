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
  type: "retry" | "fallback" | "529_dropped" | "max_tokens_adjust" | "persistent_retry_wait" | "auth_refresh";
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
  /** 降级目标模型 */
  fallbackModel?: string;
  /** 查询来源（后台 529 丢弃时） */
  querySource?: string;
  /** max_tokens 调整：原始值 */
  originalTokens?: number;
  /** max_tokens 调整：新值 */
  adjustedTokens?: number;
}

/**
 * 默认的 Telemetry 处理器：通过 debug logger 记录。
 * 生产环境可替换为对接监控系统（如 Prometheus / Datadog）。
 */
export function defaultTelemetryHandler(event: RetryTelemetryEvent): void {
  const log = getLogger();

  switch (event.type) {
    case "retry":
      log.info("TELEMETRY", `[retry] ${event.model} phase=${event.phase} attempt=${event.attempt} delay=${event.delayMs}ms error=${event.error}`);
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
  }
}
