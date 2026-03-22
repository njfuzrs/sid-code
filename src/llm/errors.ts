/**
 * LLM 错误分类体系
 * 将原始错误分为 Terminal / Retryable / StreamValidation 三类
 */

/** 不可重试的终端错误（模型不存在、认证失败、配额耗尽） */
export class TerminalError extends Error {
  constructor(message: string, public readonly reason: TerminalReason) {
    super(message);
    this.name = "TerminalError";
  }
}

export type TerminalReason =
  | "auth_failed"          // API Key 无效
  | "model_not_found"      // 模型不存在
  | "quota_exhausted"      // 配额永久耗尽
  | "content_policy"       // 内容策略拒绝
  | "invalid_request";     // 请求参数错误

/** 可重试的瞬态错误（限流、过载、网络抖动） */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly reason: RetryableReason,
    public readonly retryAfterMs?: number,  // 服务器建议的重试延迟
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export type RetryableReason =
  | "rate_limit"           // 429 限流
  | "overloaded"           // 503 过载
  | "network_error"        // 网络连接错误
  | "timeout"              // 超时
  | "server_error";        // 500/502 服务端错误

/** 流式内容验证错误（响应不完整、工具调用格式错误） */
export class StreamValidationError extends Error {
  constructor(
    message: string,
    public readonly reason: StreamValidationReason,
  ) {
    super(message);
    this.name = "StreamValidationError";
  }
}

export type StreamValidationReason =
  | "no_finish_reason"         // 流结束但没有 finish_reason
  | "malformed_tool_call"      // 工具调用 JSON 解析失败
  | "empty_response";          // 响应为空

/** 可重试的网络错误码 */
const RETRYABLE_NETWORK_CODES = [
  "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND",
  "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH",
];

/**
 * 从原始错误中提取网络错误码（遍历 cause 链，最多 5 层）
 */
export function getNetworkErrorCode(error: unknown): string | undefined {
  let current: any = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current.code && typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return undefined;
}

/**
 * 将原始错误分类为 Terminal / Retryable / 未知
 * 供 fallback.ts 和 provider 使用
 */
export function classifyError(error: unknown): TerminalError | RetryableError | Error {
  const msg = error instanceof Error ? error.message : String(error);
  const lowerMsg = msg.toLowerCase();

  // 1. 终端错误
  if (lowerMsg.includes("401") || lowerMsg.includes("authentication") || lowerMsg.includes("invalid api key")) {
    return new TerminalError(msg, "auth_failed");
  }
  if (lowerMsg.includes("404") || lowerMsg.includes("model_not_found") || lowerMsg.includes("not found")) {
    return new TerminalError(msg, "model_not_found");
  }
  if (lowerMsg.includes("content_policy") || lowerMsg.includes("safety")) {
    return new TerminalError(msg, "content_policy");
  }
  if (lowerMsg.includes("400") || lowerMsg.includes("invalid_request")) {
    return new TerminalError(msg, "invalid_request");
  }

  // 2. 可重试错误
  if (lowerMsg.includes("429") || lowerMsg.includes("rate_limit")) {
    const retryAfter = parseRetryAfter(msg);
    return new RetryableError(msg, "rate_limit", retryAfter);
  }
  if (lowerMsg.includes("overloaded") || lowerMsg.includes("503")) {
    return new RetryableError(msg, "overloaded");
  }
  if (lowerMsg.includes("502") || lowerMsg.includes("500") || lowerMsg.includes("server_error")) {
    return new RetryableError(msg, "server_error");
  }
  if (lowerMsg.includes("timeout") || lowerMsg.includes("etimedout")) {
    return new RetryableError(msg, "timeout");
  }

  // 3. 网络错误码检测
  const code = getNetworkErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.includes(code)) {
    return new RetryableError(msg, "network_error");
  }

  // 4. 无法分类，返回原始错误
  return error instanceof Error ? error : new Error(msg);
}

/** 从错误信息中解析 retry-after（秒 → 毫秒） */
function parseRetryAfter(msg: string): number | undefined {
  const match = msg.match(/retry[_-]after[:\s"]*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (seconds > 0 && seconds <= 300) return seconds * 1000;
  }
  return undefined;
}
