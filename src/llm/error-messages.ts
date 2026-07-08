/**
 * 错误码 → 用户友好文案映射表。
 *
 * 基于 errors.ts 的 TerminalReason / RetryableReason / StreamValidationReason 枚举，
 * 为统一错误面板（ErrorPanel）提供结构化的标题+建议方案。
 *
 * 使用方：app.ts 的 pushErrorPanel 在收到 system/error 或 fatal_error 时调用
 * lookupErrorMessage / inferErrorCode 生成面板内容。
 */

export interface ErrorUserMessage {
  title: string;
  suggestion: string;
}

/**
 * 错误码 → 用户文案映射。键为 TerminalReason | RetryableReason | StreamValidationReason | 自定义扩展码。
 */
export const ERROR_USER_MESSAGES: Record<string, ErrorUserMessage> = {
  // ─── TerminalReason（不重试，需用户干预）───
  auth_failed: {
    title: "API Key 无效或已过期",
    suggestion: "请检查 ~/.sid-code/settings.json 中的 apiKey 配置，或确认环境变量 OPENAI_API_KEY / ANTHROPIC_API_KEY 是否正确设置",
  },
  model_not_found: {
    title: "模型不存在或不可用",
    suggestion: "请确认 settings.json 的 model 字段与网关实际可用模型一致（区分大小写）",
  },
  quota_exhausted: {
    title: "账户配额已耗尽",
    suggestion: "请检查 API 账户余额，或在 settings.json 中切换到其他 provider / fallbackModel",
  },
  content_policy: {
    title: "内容策略拒绝",
    suggestion: "请求内容触发了模型安全过滤，请修改提示内容后重试",
  },
  invalid_request: {
    title: "请求参数错误",
    suggestion: "请检查模型配置参数是否有效（如 maxTokens、temperature 范围）",
  },

  // ─── RetryableReason（系统已自动重试，持续失败才展示）───
  rate_limit: {
    title: "请求被限流 (429)",
    suggestion: "系统正在自动重试退避。若持续出现，请降低请求频率或升级 API 计划",
  },
  overloaded: {
    title: "服务过载 (529/503)",
    suggestion: "API 服务暂时过载，系统已自动重试。若持续出现请稍后再试",
  },
  network_error: {
    title: "网络连接错误",
    suggestion: "请检查网络连接是否正常，以及 API 地址配置是否可达",
  },
  timeout: {
    title: "请求超时",
    suggestion: "网络或网关响应缓慢，系统已重试。若反复出现请检查网络连接或增大超时配置",
  },
  server_error: {
    title: "服务端错误 (5xx)",
    suggestion: "API 服务暂时不稳定，已自动重试。若持续出现请稍后再试或切换 provider",
  },
  request_timeout: {
    title: "请求超时 (408)",
    suggestion: "服务端处理超时，已自动重试。若持续出现请简化请求内容或增大 timeout 配置",
  },
  lock_timeout: {
    title: "资源锁超时 (409)",
    suggestion: "并发冲突导致锁等待超时，已自动重试",
  },

  // ─── StreamValidationReason ───
  no_finish_reason: {
    title: "流式响应未正常结束",
    suggestion: "模型流被意外截断，系统已自动重试。若持续出现可能是网络不稳定",
  },
  malformed_tool_call: {
    title: "工具调用格式错误",
    suggestion: "模型返回的工具调用 JSON 解析失败，已自动重试",
  },
  empty_response: {
    title: "模型返回空响应",
    suggestion: "疑似模型不可用或网关返回错误页。请检查 model/fallbackModel 配置是否为真实可用模型",
  },

  // ─── 自定义扩展码（非 errors.ts 枚举，但实际出现的场景）───
  subagent_failed: {
    title: "子代理执行失败",
    suggestion: "请检查子代理使用的模型是否可用，或重试当前操作",
  },
  html_error_page: {
    title: "网关返回非流式错误页",
    suggestion: "网关对当前模型/渠道返回了 HTML 错误页（而非 SSE 流）。请确认模型 ID 与网关配置一致",
  },
  unknown_stop_reason: {
    title: "模型以未识别的停止原因结束",
    suggestion: "若回答不完整，请重新发送消息继续",
  },
};

/**
 * 从错误消息文本推断 errorCode。
 * 策略：按关键词逐条匹配，返回第一个命中的 code。
 * 找不到时返回 undefined（调用方可 fallback 到通用错误）。
 */
export function inferErrorCode(message: string): string | undefined {
  if (!message) return undefined;
  const lower = message.toLowerCase();

  // 优先级从高到低（越具体越靠前）
  if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("api key")) {
    return "auth_failed";
  }
  if (lower.includes("model_not_found") || lower.includes("model not found") || lower.includes("does not exist")) {
    return "model_not_found";
  }
  if (lower.includes("quota") || lower.includes("insufficient_quota") || lower.includes("billing")) {
    return "quota_exhausted";
  }
  if (lower.includes("content_policy") || lower.includes("content filter") || lower.includes("safety")) {
    return "content_policy";
  }
  if (lower.includes("invalid_request") || lower.includes("invalid request") || lower.includes("400")) {
    return "invalid_request";
  }
  if (lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("429")) {
    return "rate_limit";
  }
  if (lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
    return "overloaded";
  }
  if (lower.includes("text/html") || lower.includes("错误页") || lower.includes("no available channel")) {
    return "html_error_page";
  }
  if (lower.includes("空响应") || lower.includes("empty_response") || lower.includes("0 内容事件")) {
    return "empty_response";
  }
  if (lower.includes("timeout") || lower.includes("超时") || lower.includes("timed out")) {
    return "timeout";
  }
  if (lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch failed")) {
    return "network_error";
  }
  if (lower.includes("500") || lower.includes("502") || lower.includes("internal server error")) {
    return "server_error";
  }
  if (lower.includes("未识别的停止原因") || lower.includes("unknown stop")) {
    return "unknown_stop_reason";
  }

  return undefined;
}

/**
 * 根据错误消息查找用户友好的文案。
 * 优先用 code 直查；无 code 时用 inferErrorCode 推断。
 * 找不到映射时返回通用 fallback。
 */
export function lookupErrorMessage(message: string, code?: string): ErrorUserMessage {
  const resolvedCode = code || inferErrorCode(message);
  if (resolvedCode && ERROR_USER_MESSAGES[resolvedCode]) {
    return ERROR_USER_MESSAGES[resolvedCode];
  }
  // 通用 fallback
  return {
    title: "运行错误",
    suggestion: "请检查错误详情，或重新发送消息重试。若持续出现，请检查配置或网络连接",
  };
}
