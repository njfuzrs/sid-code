/**
 * 结构化 API 调用日志
 *
 * 职责（对标 Claude Code 的 logging.ts）：
 * - 记录每次 API 调用的关键指标（model / tokens / cache / duration / ttfb / cost / stalls）
 * - 记录失败调用的分类标签，便于分析追踪
 *
 * 复用项目现有 getLogger()，不引入新的日志后端。
 */

import { getLogger } from "../debug/index.ts";

/** API 调用指标 */
export interface APICallMetrics {
  // 模型信息
  model: string;
  // Token 用量
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  // 性能指标
  durationMs: number;
  ttfbMs: number;
  /** 第几次尝试成功（1-based） */
  attempt: number;
  // 请求追踪
  /** 服务端请求 ID（x-request-id） */
  requestId?: string;
  /** 客户端请求 ID（x-client-request-id） */
  clientRequestId: string;
  stopReason: string | null;
  // 成本
  costUSD: number;
  // 上下文
  querySource: string;
  // 流式指标
  stallCount: number;
  totalStallTimeMs: number;
  didFallbackToNonStreaming: boolean;
}

/** 记录 API 调用成功 */
export function logAPISuccess(metrics: APICallMetrics): void {
  const log = getLogger();
  log.info("API", "请求成功", {
    model: metrics.model,
    tokens: `${metrics.inputTokens}in/${metrics.outputTokens}out`,
    cache: `${metrics.cacheReadInputTokens}read/${metrics.cacheCreationInputTokens}create`,
    duration: `${metrics.durationMs}ms`,
    ttfb: `${metrics.ttfbMs}ms`,
    cost: `$${metrics.costUSD.toFixed(4)}`,
    attempt: metrics.attempt,
    stop: metrics.stopReason,
    stalls:
      metrics.stallCount > 0
        ? `${metrics.stallCount}次/${metrics.totalStallTimeMs}ms`
        : "无",
    ...(metrics.didFallbackToNonStreaming ? { fallback: "非流式" } : {}),
    ...(metrics.requestId ? { reqId: metrics.requestId } : {}),
    clientReqId: metrics.clientRequestId,
    source: metrics.querySource,
  });
}

/** 记录 API 调用失败 */
export function logAPIError(
  error: unknown,
  model: string,
  attempt: number,
  querySource: string,
  category: string,
  clientRequestId?: string,
): void {
  const log = getLogger();
  log.error("API", "请求失败", {
    model,
    attempt,
    querySource,
    category,
    ...(clientRequestId ? { clientReqId: clientRequestId } : {}),
    error: error instanceof Error ? error.message : String(error),
  });
}

/** 生成客户端请求 ID */
export function generateClientRequestId(): string {
  return crypto.randomUUID();
}
