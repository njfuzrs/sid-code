/**
 * LLM 错误分类体系
 * 将原始错误分为 Terminal / Retryable / StreamValidation 三类
 *
 * 增强（Phase 1.1）：新增 x-should-retry header 解析、rate-limit-reset header 解析、
 * 更细粒度的 HTTP 状态码分类（408/409）、response headers 提取与 Retry-After 精确解析。
 */

// ─── 遍历 cause 链的常量 ───
// 保持与原始实现一致的深度限制
const MAX_CAUSE_DEPTH = 5;

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

/** 可重试的瞬态错误（限流、过载、网络抖动、请求超时、锁超时） */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly reason: RetryableReason,
    public readonly retryAfterMs?: number,  // 服务器建议的重试延迟（毫秒）
    /** 服务端明确指示应该重试（来自 x-should-retry header） */
    public readonly serverInstructedRetry = false,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export type RetryableReason =
  | "rate_limit"           // 429 限流
  | "overloaded"           // 529/503 过载
  | "network_error"        // 网络连接错误
  | "timeout"              // 超时
  | "server_error"         // 500/502 服务端错误
  | "request_timeout"      // 408 请求超时
  | "lock_timeout";        // 409 锁超时

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

/**
 * 流内错误（T6）：HTTP 200 但流内事件携带的服务端错误（如 Anthropic 的
 * overloaded_error、OpenAI 的 error chunk）。继承 RetryableError，让 fallback.ts
 * 的流式重试链天然识别为可重试，而无需依赖错误消息文本关键词匹配。
 *
 * 与普通 RetryableError 的区别：streamLevel=true 标记它来自"伪装成功的流"
 * （fail-fast 依据），并保留 provider / errorType / statusCode 供可观测性归因。
 */
export class StreamLevelError extends RetryableError {
  readonly streamLevel = true;
  constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    message: string,
    reason: RetryableReason = "overloaded",
    retryAfterMs?: number,
  ) {
    super(message, reason, retryAfterMs);
    this.name = "StreamLevelError";
  }
}

/** 用户或系统主动中断请求 */
export class RequestAbortedError extends Error {
  /**
   * 触发中断的 abort reason（若可得）。用于下游结构性区分"内部超时自愈中断"
   * 与"用户主动取消"——见 INTERNAL_TIMEOUT_ABORT_REASONS。stream-processor 的
   * abort-race Promise 在 signal 被 abort 时 reject 本错误，携带此 reason 让
   * query/loop.ts 无需依赖错误消息文本即可正确分类。
   */
  constructor(message = "Request aborted", public readonly abortReason?: unknown) {
    super(message);
    this.name = "RequestAbortedError";
  }
}

/**
 * 项目内部使用的 abort reason 字符串（单一事实源）。
 *
 * 背景：`AbortController.abort(reason)` 传入字符串时，被取消的 fetch / SDK 内部 Promise
 * 会以**这个裸字符串**作为 reject 值（而非 DOMException AbortError）。这些孤儿 Promise
 * 一旦冒泡到 `process.on("unhandledRejection")`，必须被 `isAbortError` 正确识别为"中断"
 * 才能短路、避免 `process.exit(1)` 崩溃。
 *
 * ⚠️ 凡是 `abortController.abort("xxx")` 用到的新 reason 字符串，都必须登记到这里，
 * 否则该 reason 触发的孤儿 rejection 会被当成真故障导致进程退出。
 * 现有调用点：app.ts onInterrupt("user-cancel")、会话级硬顶("session-timeout"：
 * tuiAgentLoop 超过 maxSessionDurationMs 上限，展示专属文案而非笼统"已取消"；旧 reason
 * "timeout" 保留登记向后兼容，不再由主路径使用)、
 * 单轮硬超时("turn-timeout")、watchdog 看门狗("watchdog-timeout")、
 * side-call 硬超时("side-call-timeout"：auto-compact / context-collapse / recall / warmup)、
 * 每轮 race settle 后的 turn 级子 controller 清理("race-settled"：loop.ts finally 主动
 * abort 本轮子 controller 以终止孤儿 fetch，仅作用于 turn 级子 signal，不回写会话级)、
 * swarm team 整体硬超时("team-hard-timeout"：swarm/team.ts)、
 * 主循环流式心跳/整体超时("stream-heartbeat-timeout" / "stream-overall-timeout"：
 * query/stream-processor.ts，对齐子代理版的 agent-stream-* 命名，见下）、
 * 子代理流整体/心跳超时("agent-stream-overall-timeout" / "agent-stream-heartbeat-timeout"：
 * agent/stream-processor.ts，combinedSignal 会传给子代理 LLM SDK，超时 abort 后底层 fetch
 * 以裸字符串 reject，若成孤儿 rejection 同样会崩溃)、
 * provider 健康告警 webhook 超时/外部中断("alert-webhook-timeout" / "external-abort"：
 * telemetry/provider-health.ts，虽当前 fetch 在 try/catch 内，登记以纵深防御)。
 */
export const ABORT_REASONS = [
  "user-cancel",
  "timeout",
  "session-timeout",
  "turn-timeout",
  "watchdog-timeout",
  "side-call-timeout",
  "race-settled",
  "team-hard-timeout",
  "stream-heartbeat-timeout",
  "stream-overall-timeout",
  "agent-stream-overall-timeout",
  "agent-stream-heartbeat-timeout",
  "alert-webhook-timeout",
  "external-abort",
] as const;

export type AbortReason = (typeof ABORT_REASONS)[number];

/**
 * ABORT_REASONS 的子集：代表"内部自愈机制的自我中断"（单轮硬超时 / 看门狗 /
 * 流式心跳-整体超时），而非用户主动取消（"user-cancel"）或外部/会话级中断。
 *
 * 背景（2026-07 根治修复，session 20260707-143411-6f4bfcc3 事故复盘）：
 * query/loop.ts 曾仅凭错误消息文本正则（/timeout|超时|timed out/i）判断是否该走
 * "超时重试"分支——但 query/stream-processor.ts 的 P0-2 abort-race 修复引入了
 * 一个措辞通用的 `RequestAbortedError("Stream aborted (abort race)")`，它在
 * `Promise.race` 中必然抢先于更具体的 `timeoutError`（消息含"timeout"）被
 * 抛出/传播——因为真正 hang 死的 `iterator.next()` 永远不会赢得这场 race。
 * 于是文本匹配落空，本该重试的超时被误判为"用户 ESC 取消"，一路静默传播到
 * app.ts：TUI 只剩 1.5s 瞬时提示"已取消当前响应"，无重试、无持久错误卡片、
 * 无 SessionEnd —— 用户体感"任务中断，没有报错，没有反应"。
 *
 * 根治：判断"是否该按超时重试"不再依赖任何错误消息文本，而是看 turn 级
 * AbortController 被 abort 时锁定的 reason 是否属于这个白名单——reason 在
 * **首次** `abort()` 调用时即被 AbortSignal 永久锁定，不受"哪个 Promise 赢得
 * race"影响，天然免疫"更具体的错误消息被更通用的错误覆盖"这整类问题。
 */
export const INTERNAL_TIMEOUT_ABORT_REASONS: ReadonlySet<AbortReason> = new Set<AbortReason>([
  "turn-timeout",
  "watchdog-timeout",
  "stream-heartbeat-timeout",
  "stream-overall-timeout",
]);

/**
 * 判断某个 abort reason 是否代表"内部超时自愈机制的自我中断"（见
 * INTERNAL_TIMEOUT_ABORT_REASONS 的背景说明）。用于 query/loop.ts 在
 * `err` 的消息文本无法识别为超时时，退回到结构性的 reason 判定，而不是
 * 把它当成用户取消静默吞掉。
 */
export function isInternalTimeoutAbortReason(reason: unknown): boolean {
  return typeof reason === "string" && INTERNAL_TIMEOUT_ABORT_REASONS.has(reason as AbortReason);
}

/**
 * 判断某个 abort reason 是否为"会话级硬顶超时"（tuiAgentLoop 超过 maxSessionDurationMs）。
 * 与用户主动取消（user-cancel）和内部单轮/看门狗超时都不同——它是"整场会话跑太久被自动
 * 结束"，需要向用户展示专属文案（"会话超过 N 分钟上限，已自动结束"）而非笼统的"已取消"。
 * 见 app.ts tuiAgentLoop 的 sessionTimer 与 catch 分支（不确定-1）。
 */
export function isSessionTimeoutAbortReason(reason: unknown): boolean {
  return reason === "session-timeout";
}

/** 可重试的网络错误码 */
const RETRYABLE_NETWORK_CODES = [
  "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND",
  "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH",
];

// ─── Cause 链遍历工具 ───

/**
 * 从原始错误中提取网络错误码（遍历 cause 链，最多 MAX_CAUSE_DEPTH 层）
 */
export function getNetworkErrorCode(error: unknown): string | undefined {
  let current: any = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (current.code && typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return undefined;
}

/**
 * 从原始错误中提取 HTTP 状态码（遍历 cause 链）
 */
export function getHTTPStatus(error: unknown): number | undefined {
  let current: any = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (typeof current.status === "number") return current.status;
    if (typeof current.statusCode === "number") return current.statusCode;
    if (current.response && typeof current.response.status === "number") {
      return current.response.status;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * 从错误中提取 HTTP response headers（遍历 cause 链）。
 * Anthropic/OpenAI SDK 通常把 headers 挂在 error.headers 或 error.response.headers。
 */
export function extractResponseHeaders(
  error: unknown,
): Headers | Record<string, string> | undefined {
  let current: any = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (current.headers) return current.headers;
    if (current.response?.headers) return current.response.headers;
    current = current.cause;
  }
  return undefined;
}

// ─── Header 解析工具（Phase 1.1 新增）───

/**
 * 从 response headers 中检查 x-should-retry。
 * 服务端通过此 header 明确告知客户端是否应该重试。
 */
export function parseXShouldRetry(error: unknown): boolean {
  const headers = extractResponseHeaders(error);
  if (!headers) return false;

  let value: string | null = null;

  if (headers instanceof Headers) {
    value = headers.get("x-should-retry");
  } else if (typeof headers === "object") {
    const keys = Object.keys(headers);
    for (const k of keys) {
      if (k.toLowerCase() === "x-should-retry") {
        value = String(headers[k]);
        break;
      }
    }
  }

  if (value !== null) {
    const lowered = value.toLowerCase().trim();
    return lowered === "true" || lowered === "yes" || lowered === "1";
  }
  return false;
}

/**
 * 从 response headers 解析 Retry-After（秒）。
 * 支持标准 Retry-After header 和自定义 retry-after 变体。
 */
export function parseRetryAfterFromHeaders(error: unknown): number | undefined {
  const headers = extractResponseHeaders(error);
  if (!headers) return undefined;

  let value: string | null = null;

  const extractFrom = (h: Headers | Record<string, string>) => {
    if (h instanceof Headers) {
      value = h.get("retry-after");
      return;
    }
    const keys = Object.keys(h);
    for (const k of keys) {
      if (k.toLowerCase() === "retry-after") {
        value = String(h[k]);
        return;
      }
    }
  };
  extractFrom(headers);

  if (value !== null && value.trim()) {
    const seconds = parseInt(value.trim(), 10);
    if (seconds > 0 && seconds <= 3600) return seconds * 1000; // 返回毫秒
  }
  return undefined;
}

/**
 * 解析速率限制重置时间 header。
 * 支持：
 * - anthropic-ratelimit-unified-reset（Anthropic 专用，ISO 8601）
 * - x-ratelimit-reset（OpenAI 风格，Unix 秒）
 * - retry-after（标准 header，秒数或 HTTP-date）
 */
export function parseRateLimitReset(error: unknown): number | undefined {
  const headers = extractResponseHeaders(error);
  if (!headers) return undefined;

  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const keys = Object.keys(headers);
    for (const k of keys) {
      if (k.toLowerCase() === name.toLowerCase()) return String(headers[k]);
    }
    return null;
  };

  // 1. Anthropic unified reset（ISO 8601）
  const unifiedReset = getHeader("anthropic-ratelimit-unified-reset");
  if (unifiedReset) {
    const parsed = Date.parse(unifiedReset);
    if (!isNaN(parsed)) return parsed;
  }

  // 2. OpenAI x-ratelimit-reset（Unix 秒）
  const openaiReset = getHeader("x-ratelimit-reset");
  if (openaiReset) {
    const seconds = parseFloat(openaiReset);
    if (seconds > 0) return seconds * 1000; // 转为毫秒
  }

  // 3. 标准 Retry-After（秒数）
  const retryAfter = getHeader("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (seconds > 0) return Date.now() + seconds * 1000;
  }

  return undefined;
}

/** 判断错误是否由 abort/signal 中断引起 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof RequestAbortedError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;

  // 关键：`abortController.abort("user-cancel")` 这类带字符串 reason 的中断，
  // 会让被取消的 fetch / SDK 内部 Promise 以**裸字符串 reason** 作为 reject 值冒泡上来。
  // 这类孤儿 rejection 既不是 Error 也没有 name，必须按 ABORT_REASONS 白名单识别，
  // 否则会被全局 unhandledRejection 兜底当成真故障 → process.exit(1) 崩溃。
  if (typeof error === "string" && (ABORT_REASONS as readonly string[]).includes(error)) {
    return true;
  }
  // 某些路径会把 AbortSignal 本身或带 .reason 的对象抛出来——一并兜住其 reason。
  if (error && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === "string" && (ABORT_REASONS as readonly string[]).includes(reason)) {
      return true;
    }
    if (isAbortError(reason)) return true;
  }

  if (error && typeof error === "object" && "name" in error) {
    const name = String((error as { name?: unknown }).name ?? "");
    // AbortError（DOM/fetch）、APIUserAbortError（@anthropic-ai/sdk）
    if (name === "AbortError" || name === "APIUserAbortError") return true;
  }

  const msg = error instanceof Error ? error.message : String(error ?? "");
  const lowerMsg = msg.toLowerCase();

  return [
    "request aborted",
    "request was aborted", // @anthropic-ai/sdk APIUserAbortError 的默认文案
    "请求已中止",
    "请求已取消",
    "用户取消",
    "operation was aborted",
    "this operation was aborted",
    "signal is aborted",
    "aborterror",
  ].some(fragment => lowerMsg.includes(fragment));
}

/** 将原始中断错误标准化为 RequestAbortedError */
export function toAbortError(error?: unknown): RequestAbortedError {
  if (error instanceof RequestAbortedError) return error;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Request aborted";
  return new RequestAbortedError(message);
}

// ─── 细粒度错误检测谓词 ───

/**
 * 判断数字串 digits 是否在 msg 中以「数字边界」命中（前后不是 0-9）。
 * 不能用裸 `.includes(digits)`：错误消息常内嵌网关 / CDN 返回的 request id、
 * trace id 等不透明标识符，可能巧合包含目标状态码的数字子串。
 *
 * 实例（2026-07-13 生产事故）：Cloudflare 502 错误消息里的
 * "(request id: 202607130613404387609908268d9d6yjWpBkX0)"，其中
 * "...1340438..." 恰好包含 "404"。用 `.includes("404")` 判定会把这个可重试的
 * 502 服务端错误误判成终端错误 model_not_found，导致重试提前放弃、直接切换到
 * fallback 模型——而此时真实故障只是上游临时过载，多等几秒重试本可成功
 * （消息里其实还有 "overloaded" 这个正确关键词，但排在判断顺序更后面的分支，
 * 被抢先命中的 "404" 短路掉了）。
 *
 * 数字边界匹配保留 "HTTP 404" "code=404" "(404)" 等合法场景，排除被更长数字
 * 串"吞掉"的巧合命中（如 "1340438" 里的 "404"）。
 */
function hasBoundaryDigits(msg: string, digits: string): boolean {
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(msg);
}

export function is408Error(error: unknown): boolean {
  const status = getHTTPStatus(error);
  if (status === 408) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return hasBoundaryDigits(msg, "408") || msg.includes("http 408") || msg.includes("status 408");
}

export function is409Error(error: unknown): boolean {
  const status = getHTTPStatus(error);
  if (status === 409) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return hasBoundaryDigits(msg, "409") || msg.includes("lock timeout") || msg.includes("conflict");
}

export function is401Error(error: unknown): boolean {
  const status = getHTTPStatus(error);
  if (status === 401) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    hasBoundaryDigits(msg, "401") ||
    msg.includes("authentication") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid x-api-key")
  );
}

/**
 * 从错误信息中解析 Retry-After（秒 → 毫秒）
 * 优先匹配 headers，回退到消息正则提取
 */
function parseRetryAfter(error: unknown): number | undefined {
  // 优先从 headers 提取
  const fromHeaders = parseRetryAfterFromHeaders(error);
  if (fromHeaders) return fromHeaders;

  // 回退：从消息中正则提取
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/retry[_-]after[:\s"]*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (seconds > 0 && seconds <= 300) return seconds * 1000;
  }
  return undefined;
}

/**
 * 结合结构化 HTTP 状态码（若可得）与数字边界文本匹配，判断错误是否对应某个状态码。
 *
 * 结构化状态码（error.status/statusCode/response.status，见 getHTTPStatus）比文本
 * 扫描更权威：一旦拿到就直接用它判定（无论真假都不再回退文本匹配），从根上避免消息
 * 正文里的不透明 ID（request id / trace id）干扰判断。只有拿不到结构化状态码时，才
 * 回退到 hasBoundaryDigits 的数字边界文本匹配。
 */
function matchesHttpStatus(structuredStatus: number | undefined, msg: string, code: string): boolean {
  if (structuredStatus !== undefined) return String(structuredStatus) === code;
  return hasBoundaryDigits(msg, code);
}

/**
 * 将原始错误分类为 Terminal / Retryable / 未知
 * 供 fallback.ts 和 provider 使用
 *
 * Phase 1.1 增强：新增 408、409、x-should-retry header 识别
 */
export function classifyError(error: unknown): TerminalError | RetryableError | Error {
  const msg = error instanceof Error ? error.message : String(error);
  const lowerMsg = msg.toLowerCase();
  // 结构化状态码只算一次，供下面所有 matchesHttpStatus 调用复用。
  const structuredStatus = getHTTPStatus(error);

  // 0. 服务端 x-should-retry header 优先
  if (parseXShouldRetry(error)) {
    const retryAfter = parseRetryAfter(error);
    return new RetryableError(msg, "server_error", retryAfter, true);
  }

  // 1. 终端错误
  if (is401Error(error)) {
    return new TerminalError(msg, "auth_failed");
  }
  // 归因脱节修复：删除裸 `"not found"` 子串命中。它不受结构化状态码约束，
  // 会把上游/网关临时返回的 "upstream not found" / "no available channel ... not found"
  // 等**可重试** 5xx 错误误判成终端 model_not_found → 提前放弃重试、直接切 fallback
  // （与本文件 hasBoundaryDigits 记录的 404-in-request-id 事故同类）。
  // 仅保留：真 404 状态码（数字边界匹配） 或 明确的 `model_not_found` 结构化标记。
  if (matchesHttpStatus(structuredStatus, lowerMsg, "404") || lowerMsg.includes("model_not_found")) {
    return new TerminalError(msg, "model_not_found");
  }
  if (lowerMsg.includes("content_policy") || lowerMsg.includes("safety")) {
    return new TerminalError(msg, "content_policy");
  }
  if (matchesHttpStatus(structuredStatus, lowerMsg, "400") || lowerMsg.includes("invalid_request")) {
    return new TerminalError(msg, "invalid_request");
  }

  // 2. 可重试错误 — 新增 408、409
  if (is408Error(error)) {
    return new RetryableError(msg, "request_timeout");
  }
  if (is409Error(error)) {
    return new RetryableError(msg, "lock_timeout");
  }
  if (matchesHttpStatus(structuredStatus, lowerMsg, "429") || lowerMsg.includes("rate_limit")) {
    const retryAfter = parseRetryAfter(error);
    return new RetryableError(msg, "rate_limit", retryAfter);
  }
  if (lowerMsg.includes("overloaded") || matchesHttpStatus(structuredStatus, lowerMsg, "529") ||
      matchesHttpStatus(structuredStatus, lowerMsg, "503") || lowerMsg.includes("insufficient_system_resource")) {
    const retryAfter = parseRetryAfter(error);
    return new RetryableError(msg, "overloaded", retryAfter);
  }
  if (matchesHttpStatus(structuredStatus, lowerMsg, "502") || matchesHttpStatus(structuredStatus, lowerMsg, "500") || lowerMsg.includes("server_error")) {
    return new RetryableError(msg, "server_error");
  }
  if (lowerMsg.includes("timeout") || lowerMsg.includes("etimedout") || msg.includes("超时")) {
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

/**
 * T6：把「流内错误」的结构化字段（provider + 上游 error.type/status + message）
 * 映射为 StreamLevelError。相比 classifyError(new Error(message)) 仅靠消息文本
 * 关键词匹配，这里优先用 provider 明确给出的错误类型（如 anthropic overloaded_error），
 * 消息不含关键词时也能正确判成 overloaded → 触发重试而非静默降级。
 *
 * @param provider  provider 名称（"anthropic" / "openai" / ...）
 * @param message   展示用错误消息
 * @param errorType 上游结构化错误类型（Anthropic: overloaded_error / api_error / rate_limit_error；OpenAI error.type / code）
 * @param statusCode 若上游附带 HTTP 语义状态码
 */
export function classifyStreamError(
  provider: string,
  message: string,
  errorType?: string,
  statusCode?: number,
): StreamLevelError | TerminalError {
  const type = (errorType ?? "").toLowerCase();
  const lowerMsg = message.toLowerCase();

  // 1. 结构化 error.type 优先（不依赖消息文本）
  if (type.includes("overloaded") || type === "overloaded_error") {
    return new StreamLevelError(provider, statusCode ?? 529, message, "overloaded");
  }
  if (type.includes("rate_limit")) {
    const retryAfter = parseRetryAfter(new Error(message));
    return new StreamLevelError(provider, statusCode ?? 429, message, "rate_limit", retryAfter);
  }
  // 认证 / 模型不存在 / 无效请求：流内也可能出现，归 Terminal（不重试）
  if (type.includes("authentication") || type === "authentication_error") {
    return new TerminalError(message, "auth_failed");
  }
  if (type.includes("not_found")) {
    return new TerminalError(message, "model_not_found");
  }
  if (type.includes("invalid_request")) {
    return new TerminalError(message, "invalid_request");
  }

  // 2. 回退：复用 classifyError 的消息文本关键词匹配
  const classified = classifyError(new Error(message));
  if (classified instanceof TerminalError) return classified;
  if (classified instanceof RetryableError) {
    return new StreamLevelError(provider, statusCode ?? 0, message, classified.reason, classified.retryAfterMs);
  }
  // 3. 兜底：无法归类的流内错误默认按 server_error 重试（流已 200，倾向瞬态）
  const finalStatus = statusCode ?? (lowerMsg.includes("529") ? 529 : 500);
  return new StreamLevelError(provider, finalStatus, message, "server_error");
}
