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
 * 瞬态错误码集合：系统会自动重试，请求恢复后提示**必须**自动消失。
 *
 * 根因（本文件此前缺这一层）：ERROR_USER_MESSAGES 在注释里已把错误分成
 * 「TerminalReason 不重试、需用户干预」与「RetryableReason 系统已自动重试」两组，
 * 但消费方 app.ts 的 pushErrorPanel 完全不区分——一律按"常驻直到用户 Ctrl+E"处理。
 * 于是 429 限流恢复后，红色卡片仍挂在界面上，而它自己的建议文案写着"系统正在自动
 * 重试退避"，呈现与文案自相矛盾，用户以为还在故障中。
 *
 * 集合边界（与 errors.ts 的枚举严格对齐，改这里先看那边）：
 * - RetryableReason 全员：限流/过载/网络/超时/5xx/408/409；
 * - StreamValidationReason 全员：流被截断/工具 JSON 坏/空响应——都由系统重试；
 * - TerminalReason 一个都不进（auth_failed/quota_exhausted 等必须留在界面上等用户处理）。
 *
 * 反向不变量：不在此集合中的错误码 = 终态错误 = 只能手动关闭。新增错误码时，
 * 若它属于"系统会自动重试"，必须同步加进这里，否则又会退化成永久残留。
 * tests/llm/error-transient-classification.test.ts 用 errors.ts 的枚举做双向对账，
 * 漏加会红。
 */
export const TRANSIENT_ERROR_CODES = new Set<string>([
  // RetryableReason（errors.ts:43）
  "rate_limit",
  "overloaded",
  "network_error",
  "timeout",
  "server_error",
  "request_timeout",
  "lock_timeout",
  // StreamValidationReason（errors.ts:63）
  "no_finish_reason",
  "malformed_tool_call",
  "empty_response",
]);

/**
 * 判断错误码是否为"系统自动重试中"的瞬态错误。
 *
 * 无 code（推断失败）时返回 false —— fail-closed 取向：宁可让一条无法归类的错误
 * 多留在界面上等用户手动关闭，也不要把真正需要干预的故障静默清掉。
 */
export function isTransientErrorCode(code?: string): boolean {
  if (!code) return false;
  return TRANSIENT_ERROR_CODES.has(code);
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
  // B5-3：服务端通过 x-should-retry: false 明确要求停止重试。
  // 这个文案要点在于把"我们主动放弃了"说清楚——否则用户看到失败会以为是重试不够。
  server_declined_retry: {
    title: "服务端明确要求停止重试",
    suggestion: "上游返回 x-should-retry: false（常见于网关判定 API Key 无效或线路不可用），已停止重试以免浪费配额。请检查 apiKey 与 baseURL 配置，或切换 provider / fallbackModel",
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

/**
 * 为无法归类 code 的错误生成稳定的去重 id（基于错误文本内容归一化后哈希）。
 *
 * 背景：此前 app.ts 对无 code 的错误用 `Date.now()` 兜底做 id——每次都不同，
 * 导致同一条反复出现的错误无法去重（面板持续堆叠新卡片直到 slice(-5) 截断），
 * 且可能与其它路径（如 fatal_error 的固定 "fatal" id）产生视觉重复。
 *
 * 归一化策略：剥离常见的易变部分（时间戳、UUID、数字），只保留错误消息的
 * 结构性主干做哈希——同一类错误（哪怕具体数值不同）会得到同一个稳定 id。
 */
export function stableErrorId(prefix: string, message: string): string {
  const normalized = message
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "") // ISO 时间戳
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "") // UUID
    .replace(/\d+/g, "") // 剩余数字（端口、耗时、计数等易变值）
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  // 简单稳定哈希（djb2），避免引入额外依赖；仅用于去重展示，非安全用途。
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}
