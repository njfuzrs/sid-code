/**
 * 增强的 API 错误分类与用户消息层
 *
 * 职责（对标 Claude Code 的 errors.ts）：
 * - 将原始错误分类为标准化的 APIErrorCategory 标签（用于日志分析追踪）
 * - 生成面向用户的、可操作的错误消息（区分交互式 / 非交互式）
 * - 提供细粒度的错误判定谓词（429 / 529 / max_tokens 溢出 / 图片超限等）
 *
 * 与 src/llm/errors.ts 的关系：
 * - llm/errors.ts 的 TerminalError / RetryableError / classifyError 保留（fallback.ts 仍在用）
 * - 本模块新增 classifyAPIError() / getErrorMessageForUser() 作为面向上层的统一接口
 * - 复用 llm/errors.ts 的 getNetworkErrorCode / isAbortError，避免重复实现
 */

import { getNetworkErrorCode, isAbortError } from "../llm/errors.ts";
import {
  extractHTTPStatus,
  getSSLErrorHint,
  getErrorMessage,
  extractConnectionErrorDetails,
} from "./error-utils.ts";

/** 标准化的错误分类标签 — 用于日志分析 */
export type APIErrorCategory =
  | "aborted" // 用户中止
  | "api_timeout" // 连接 / 流式超时
  | "rate_limit" // 429 速率限制
  | "server_overload" // 529 过载
  | "repeated_529" // 连续 529
  | "prompt_too_long" // 上下文溢出
  | "max_tokens_overflow" // input + max_tokens > context
  | "image_too_large" // 图片超限
  | "pdf_too_large" // PDF 超限
  | "tool_use_mismatch" // tool_use/tool_result 不匹配
  | "invalid_model" // 模型不存在
  | "credit_balance_low" // 余额不足
  | "invalid_api_key" // API Key 无效
  | "auth_error" // 通用认证错误
  | "server_error" // 5xx 服务端错误
  | "ssl_cert_error" // SSL 证书错误
  | "connection_error" // 连接错误
  | "unknown"; // 未知

// ─── 细粒度错误判定谓词 ───

function lower(error: unknown): string {
  return getErrorMessage(error).toLowerCase();
}

export function isTimeoutError(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code === "ETIMEDOUT") return true;
  const msg = lower(error);
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("超时") ||
    msg.includes("etimedout")
  );
}

export function is429Error(error: unknown): boolean {
  if (extractHTTPStatus(error) === 429) return true;
  const msg = lower(error);
  return msg.includes("429") || msg.includes("rate_limit") || msg.includes("rate limit");
}

export function is529Error(error: unknown): boolean {
  if (extractHTTPStatus(error) === 529) return true;
  const msg = lower(error);
  // Anthropic 用 529 + "overloaded"；部分网关用 503
  return msg.includes("529") || msg.includes("overloaded_error") || msg.includes("overloaded");
}

export function is401Error(error: unknown): boolean {
  if (extractHTTPStatus(error) === 401) return true;
  const msg = lower(error);
  return (
    msg.includes("401") ||
    msg.includes("authentication") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid x-api-key")
  );
}

export function is404Error(error: unknown): boolean {
  if (extractHTTPStatus(error) === 404) return true;
  const msg = lower(error);
  return msg.includes("404") || msg.includes("model_not_found") || msg.includes("not_found_error");
}

/**
 * 上下文超限判定 —— **全仓唯一事实源（SSOT）**，勿再另写一份 pattern 列表。
 *
 * 判据是「上下文装不下」这一类服务端错误的措辞并集。各供应商措辞差异很大，且都不带
 * 稳定的错误码，只能靠文本特征匹配——正因如此，**必须只有一份列表**：
 *
 * 2026-08-01 事故（本条注释的由来）：曾有三份各自维护的重复实现，pattern 互不相同——
 *   - `query/reactive-compact.ts::isPromptTooLongError`（**驱动真实压缩的活路径**）
 *   - 本函数（此前只被 classifyAPIError 用于日志打标）
 *   - `llm/model-capabilities.ts::learnFromError` 的 contextExceeded 分支
 * 实测活路径漏判 4 种真实措辞：`context_length_exceeded`、`exceeds the context window`、
 * `too many tokens`、`reduce the length`。后果不是报错而是**该压缩时不压缩**——
 * reactiveCompact 不触发，用户直接吃一个本可自动恢复的失败。三份列表里覆盖最全的
 * 反而是当时只用来打日志标签的这一份，最需要它的活路径最弱。
 *
 * 现在另两处都委托到这里（见各自注释）。新增措辞只加在这个函数里。
 */
export function isPromptTooLong(error: unknown): boolean {
  const msg = lower(error);
  return (
    msg.includes("prompt is too long") ||
    msg.includes("prompt too long") ||
    msg.includes("prompt_too_long") ||
    msg.includes("context length") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("exceeds the context window") ||
    msg.includes("context window") ||
    msg.includes("too many tokens") ||
    msg.includes("reduce the length") ||
    // 「token…exceed」的松散组合（如 "total tokens exceeded the limit"）。
    // 放在最后：它最宽，前面的精确特征先行命中，便于排查是哪一条匹配的。
    (msg.includes("token") && msg.includes("exceed"))
  );
}

export function isImageTooLarge(error: unknown): boolean {
  const msg = lower(error);
  return (
    (msg.includes("image") && (msg.includes("too large") || msg.includes("exceeds"))) ||
    msg.includes("image_too_large")
  );
}

export function isPdfTooLarge(error: unknown): boolean {
  const msg = lower(error);
  return (
    (msg.includes("pdf") && (msg.includes("too large") || msg.includes("exceeds"))) ||
    msg.includes("pdf_too_large")
  );
}

export function isToolUseMismatch(error: unknown): boolean {
  const msg = lower(error);
  return (
    msg.includes("tool_use") &&
    (msg.includes("tool_result") || msg.includes("without") || msg.includes("did not have"))
  );
}

export function isCreditBalanceLow(error: unknown): boolean {
  const msg = lower(error);
  return (
    msg.includes("credit balance") ||
    msg.includes("insufficient") ||
    msg.includes("billing") ||
    (msg.includes("quota") && msg.includes("exceeded"))
  );
}

export function isServerError(error: unknown): boolean {
  const status = extractHTTPStatus(error);
  if (status !== undefined && status >= 500 && status !== 529) return true;
  const msg = lower(error);
  return (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("server_error") ||
    msg.includes("internal server error")
  );
}

export function isConnectionError(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code) {
    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ].includes(code);
  }
  const msg = lower(error);
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up")
  );
}

/**
 * 解析 "input length and max_tokens exceed context limit" 错误。
 * 返回 { inputTokens, contextLimit } 或 undefined。
 */
export function parseMaxTokensOverflowError(
  error: unknown,
): { inputTokens: number; contextLimit: number } | undefined {
  const msg = getErrorMessage(error);
  // 匹配: "188059 + 20000 > 200000"
  const sumMatch = msg.match(/(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
  if (sumMatch) {
    return {
      inputTokens: parseInt(sumMatch[1], 10),
      contextLimit: parseInt(sumMatch[3], 10),
    };
  }
  // 匹配: "prompt is too long: 137500 tokens > 135000 maximum"
  const tokenMatch = msg.match(/(\d+)\s*tokens?\s*>\s*(\d+)/i);
  if (tokenMatch) {
    return {
      inputTokens: parseInt(tokenMatch[1], 10),
      contextLimit: parseInt(tokenMatch[2], 10),
    };
  }
  return undefined;
}

/**
 * 从错误信息 / headers 中提取 Retry-After（秒）。
 */
export function extractRetryAfter(error: unknown): number | undefined {
  const msg = getErrorMessage(error);
  const match = msg.match(/retry[_-]?after["':\s]*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (seconds > 0 && seconds <= 600) return seconds;
  }
  return undefined;
}

/**
 * 将原始错误分类为标准化标签。
 * 按优先级匹配：中止 > 超时 > max_tokens 溢出 > prompt 过长 > 429 > 529 >
 * 认证 > 模型 > 媒体超限 > tool_use > 余额 > SSL > 连接 > 5xx > 未知。
 *
 * max_tokens_overflow 必须先于 prompt_too_long 判定（前者可自动恢复，后者触发压缩）。
 */
export function classifyAPIError(error: unknown): APIErrorCategory {
  if (isAbortError(error)) return "aborted";
  if (isTimeoutError(error)) return "api_timeout";

  // max_tokens 溢出（"input + max_tokens > context"）优先于 prompt_too_long
  if (parseMaxTokensOverflowError(error) && /\d+\s*\+\s*\d+\s*>/.test(getErrorMessage(error))) {
    return "max_tokens_overflow";
  }
  if (isPromptTooLong(error)) return "prompt_too_long";

  if (is429Error(error)) return "rate_limit";
  if (is529Error(error)) return "server_overload";

  if (isCreditBalanceLow(error)) return "credit_balance_low";
  if (is401Error(error)) return "invalid_api_key";
  if (is404Error(error)) return "invalid_model";

  if (isImageTooLarge(error)) return "image_too_large";
  if (isPdfTooLarge(error)) return "pdf_too_large";
  if (isToolUseMismatch(error)) return "tool_use_mismatch";

  if (getSSLErrorHint(error)) return "ssl_cert_error";
  if (isConnectionError(error)) return "connection_error";
  if (isServerError(error)) return "server_error";

  return "unknown";
}

/** getErrorMessageForUser 的返回结构 */
export interface UserErrorMessage {
  /** 面向用户的可读描述 */
  content: string;
  /** 错误分类标签 */
  category: APIErrorCategory;
  /** 原始错误细节（prompt_too_long 时供响应式压缩解析 token 数） */
  errorDetails?: string;
}

/**
 * 生成面向用户的错误消息。
 * 核心原则：每种错误都有可操作的提示。
 */
export function getErrorMessageForUser(
  error: unknown,
  model: string,
  options?: { isInteractive?: boolean },
): UserErrorMessage {
  const isInteractive = options?.isInteractive ?? true;
  const category = classifyAPIError(error);

  switch (category) {
    case "aborted":
      return { content: "请求已取消", category };

    case "api_timeout":
      return { content: "请求超时，请重试", category };

    case "max_tokens_overflow":
      return {
        content: "输出预算超出上下文限制，正在自动调整...",
        category,
        errorDetails: getErrorMessage(error),
      };

    case "prompt_too_long":
      return {
        content: "上下文过长，正在自动压缩...",
        category,
        errorDetails: getErrorMessage(error),
      };

    case "rate_limit": {
      const retryAfter = extractRetryAfter(error);
      if (retryAfter && retryAfter < 60) {
        return { content: `API 限流，${retryAfter} 秒后重试`, category };
      }
      return { content: "API 配额已用完，请稍后再试或检查账户配额", category };
    }

    case "server_overload":
      return { content: "API 服务过载，正在重试...", category };

    case "repeated_529":
      return { content: "API 服务持续过载，已切换备用模型", category };

    case "credit_balance_low":
      return {
        content: "账户余额不足，请前往控制台充值或检查账单",
        category,
      };

    case "invalid_api_key":
      return {
        content: "API Key 无效或已过期，请检查配置（~/.sid-code/config）",
        category,
      };

    case "invalid_model":
      return {
        content: `模型 ${model} 不可用，请使用 /model 切换模型`,
        category,
      };

    case "image_too_large":
      return {
        content: isInteractive ? "图片太大，请缩小后重试" : "图片太大，请使用更小的图片",
        category,
      };

    case "pdf_too_large":
      return { content: "PDF 文件太大，请拆分或压缩后重试", category };

    case "tool_use_mismatch":
      return {
        content: "工具调用与结果不匹配（内部错误），正在修复消息序列...",
        category,
      };

    case "ssl_cert_error": {
      const hint = getSSLErrorHint(error);
      return { content: `SSL 证书错误：${hint ?? "请检查代理配置"}`, category };
    }

    case "connection_error": {
      const details = extractConnectionErrorDetails(error);
      const codeHint = details?.code ? `（${details.code}）` : "";
      return { content: `网络连接失败${codeHint}，请检查网络`, category };
    }

    case "server_error":
      return { content: "服务端错误，正在重试...", category };

    default:
      return {
        content: `API 错误：${getErrorMessage(error)}`,
        category: "unknown",
      };
  }
}
