/**
 * LLM 错误类型与结构化字段提取工具。
 *
 * 2026-10-08：分类与生死决策已迁出本文件。`classifyError` / `classifyStreamError` /
 * `TerminalError` / `StreamLevelError` / 网关 401 占位句闸门全部删除——它们是「单次观测即判死」
 * 的载体（会话 20261008-173228-baeb949d）。现在的链路是：
 *   `error-normalize.ts`（两种到达形态 → 同一个 NormalizedLLMError → 唯一分类器 classifyFamily）
 *   → `recovery-policy.ts`（纯函数 decideRecovery：分类只调预算，不判生死）。
 * 本文件只保留错误类、header / 状态码 / 网络码提取、abort 判定与细粒度谓词。
 */

import { matchErrorLexicon } from "./error-lexicon.ts";

// ─── 遍历 cause 链的常量 ───
// 保持与原始实现一致的深度限制
const MAX_CAUSE_DEPTH = 5;

/**
 * 「嫌疑」类原因：认证 / 请求被拒 / 服务端拒绝重试。
 *
 * 原名 `TerminalReason`。改名是语义变更：它们不再意味着「不可重试、立刻判死」，
 * 只决定走 auth_suspect / request_suspect 哪一族的预算（见 recovery-policy.ts）。
 */
export type SuspectReason =
  | "auth_failed" // 401 / 403 / 认证类文案
  | "model_not_found" // 404 / 模型不存在
  | "quota_exhausted" // 402 / 余额不足
  | "content_policy" // 内容策略拒绝
  | "invalid_request" // 400 / 422
  | "usage_limit_reached" // 用量到顶（会话 / 周窗口）
  | "server_declined_retry"; // 服务端明确要求不要重试（x-should-retry: false）

/** 可重试的瞬态错误（限流、过载、网络抖动、请求超时、锁超时） */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly reason: RetryableReason,
    public readonly retryAfterMs?: number, // 服务器建议的重试延迟（毫秒）
    /** 服务端明确指示应该重试（来自 x-should-retry header） */
    public readonly serverInstructedRetry = false,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export type RetryableReason =
  | "rate_limit" // 429 限流
  | "overloaded" // 529/503 过载
  | "network_error" // 网络连接错误
  | "timeout" // 超时
  | "server_error" // 500/502 服务端错误
  | "request_timeout" // 408 请求超时
  | "lock_timeout"; // 409 锁超时

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
  | "no_finish_reason" // 流结束但没有 finish_reason
  | "malformed_tool_call" // 工具调用 JSON 解析失败
  | "empty_response"; // 响应为空

/** 用户或系统主动中断请求 */
/**
 * 流内 `error` 事件抛到上层时的结构化载体（2026-09-06）。
 *
 * 根因：`query/stream-processor.ts` 与 `entrypoints/headless.ts` 遇到流内 error 事件时
 * 都写 `throw new Error(\`LLM 错误: ${event.error.message}\`)` —— `event.error` 上的
 * `statusCode` / `type` / `streamLevel` **在抛的那一刻全部丢弃**。而 TUI 侧
 * （app.ts 的 pushErrorPanel）只能拿到一个字符串，于是被迫用 `inferErrorCode` 从
 * 文本里"猜"状态码。子代理路径（`agent/stream-processor.ts`）反而是对的：它用
 * `errorMeta` 把三个字段原样带出。同一份数据，两条路径一条留一条丢。
 *
 * 猜的代价是真实的：网关文本「当前分组上游负载已饱和」既无 429 也无 "rate limit"，
 * 猜不出来就退化成通用「运行错误」（轨迹 20260905-215535-664d3239）；反向还会猜错 ——
 * `"gateway trace 5024"` 里的 `502` 曾被当成 server_error。
 *
 * 所以这里把结构化字段挂在 Error 上一路带到 UI：**有结构化 code 时优先用它**，
 * 文本推断只作兜底。`message` 保持与旧行为完全一致（含 `LLM 错误: ` 前缀），
 * 任何只读 `.message` 的既有调用方不受影响。
 */
export class LLMStreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorType?: string,
    public readonly streamLevel?: boolean,
  ) {
    super(message);
    this.name = "LLMStreamError";
  }
}

export class RequestAbortedError extends Error {
  /**
   * 触发中断的 abort reason（若可得）。用于下游结构性区分"内部超时自愈中断"
   * 与"用户主动取消"——见 INTERNAL_TIMEOUT_ABORT_REASONS。stream-processor 的
   * abort-race Promise 在 signal 被 abort 时 reject 本错误，携带此 reason 让
   * query/loop.ts 无需依赖错误消息文本即可正确分类。
   */
  constructor(
    message = "Request aborted",
    public readonly abortReason?: unknown,
  ) {
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
  // 缺口1 h2A：mid-turn `now` 级抢占（用户显式中断/改向触发的优雅收束）。
  // 登记进白名单确保抢占走 isAbortError 总闸门识别，不裸字符串 reject（不变量 2）。
  "midturn-preempt",
  // H10：子代理流整体硬超时（agentic-loop.ts 的 5min Promise.race 兜底）。此前 reject 裸
  // `new Error("子代理流式超时…")`，不携带 abort reason、不在任何白名单——与主路径「判超时看
  // reason 白名单而非错误文本」的口径分裂。改用 controller.abort(AGENT_STREAM_TIMEOUT_REASON)
  // 后，登记于此确保孤儿 rejection 被 isAbortError 识别、且可被 isInternalTimeoutAbortReason 命中。
  "agent-stream-timeout",
  // P0-1：子代理墙钟**硬 kill** 兜底（detach 之后的最后一道闸）。
  //
  // 语义变更的落点：改造前墙钟到点即 `timeoutCtrl.abort()`，成果被整句丢弃（184 万
  // input token 产出归零的直接原因）。改造后墙钟到点只做 **detach**（转后台继续跑、
  // 前台交回残卷，不 abort），真正 abort 只在 detach 之后又跑满 SUBAGENT_HARD_KILL_MULTIPLIER
  // 倍时长才发生——那已不是"跑得慢"而是"跑失控了"。
  //
  // 必须登记：detach 后的续跑发生在**没有前台 await 的后台**，硬 kill 时底层 fetch 会以
  // 这个裸字符串 reject，未登记就是一条绕过 isAbortError 总闸门的孤儿 rejection（历史事故：
  // 自定义 reason 绕过闸门致崩溃）。
  "subagent-hard-kill",
] as const;

/** H10：子代理流整体硬超时的 abort reason（单一事实源，供 agentic-loop 使用）。 */
export const AGENT_STREAM_TIMEOUT_REASON = "agent-stream-timeout" as const;
/** H10：side-call 硬超时的 abort reason（与既有 "side-call-timeout" 一致，供各 side-call 复用）。 */
export const SIDE_CALL_TIMEOUT_REASON = "side-call-timeout" as const;
/**
 * P0-1：子代理硬 kill 的 abort reason（单一事实源，供 sub-agent.ts 使用）。
 *
 * 只在 detach 之后又跑满硬 kill 期限时才用。墙钟到点本身**不再** abort（改为 detach），
 * 这是本次修复的语义核心——见 ABORT_REASONS 里 "subagent-hard-kill" 的说明。
 */
export const SUBAGENT_HARD_KILL_REASON = "subagent-hard-kill" as const;

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
  // H10：子代理流整体超时也是「内部自愈机制的自我中断」，与 turn/watchdog 同类——一旦子代理
  // 错误改为依 reason 分类（区分「内部超时可重试」vs「用户取消不重试」），需命中本白名单。
  // 注：side-call-timeout 不入此白名单——side-call 是后台任务，各自 catch 静默降级，不参与
  // 主循环的超时重试 reason 分类；登记进 ABORT_REASONS 仅为防孤儿 rejection 崩溃即可。
  "agent-stream-timeout",
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
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
];

/**
 * 可重试的"连接被关闭"错误消息片段（小写）。
 * 这类瞬态断连常以裸 Error 冒泡（无 .code 字段），只能靠消息文本兜底识别。
 * 与 isAbortError 的白名单严格互斥——这些是**网络故障**（该重试），不是用户/超时中断（不该重试）。
 * 来源：Bun/undici fetch 流式断连、各家网关 socket RST 的实测文案。
 */
const RETRYABLE_CONNECTION_MESSAGES = [
  "socket connection was closed",
  "socket hang up",
  "other side closed",
  "connection closed",
  "connection reset",
  "econnreset",
  "epipe",
  "network error",
  "failed to fetch",
  "terminated",
  // 2026-10-08：Anthropic SDK 的 `Connection error.`（会话 20261005-234012 首轮零重试的原文）
  // 与 Bun fetch 的网络失败（`fetch failed` / `Unable to connect…`，它们是 TypeError，
  // 必须在 origin 判定里先于「是 TypeError → 本地 bug」认出来）。
  "connection error",
  "connection refused",
  "unable to connect",
  "fetch failed",
  // ─── B5-2：流被中途截断（响应体没读完就断） ───
  //
  // 这类故障与上面的"连接被对端关闭"同源、同为瞬态，但表现在**更上层**：连接确实
  // 关了，可我们拿到的错误是解析器抱怨"数据不完整"而非 socket 层的 RST，于是既命不中
  // RETRYABLE_NETWORK_CODES（无 .code），也命不中上面那批 socket 文案。
  // 实测（本方案附录 A1）：`unexpected end of JSON input` / `Premature close` 落到
  // classifyError 的"无法分类"分支 → **不重试**，而它们恰恰是最该重试的一类。
  //
  // 为什么修分类器本体、而不是"放宽子代理门槛到与主路径一致"（旧方案的方向）：
  // 主路径对裸 Error 也重试，那是主路径自身的缺陷（一个 TypeError 会被重试满次、
  // 每次退避最长 120s）。把子代理"对齐"到那个语义是扩散缺陷；修这里则两条路径同时
  // 受益，且门槛不放宽——只有明确是截断的才重试。
  //
  // 文案来源与 `api/stream-handler.ts` 的 isStreamingTransportError 同源（那里已把
  // 这批判为"传输层错误 → 该走非流式降级"）。同一批文案在一处判该降级、在另一处判
  // 不可分类不重试，本身就是两份实现漂移的证据。
  "unexpected end of json", // "Unexpected end of JSON input"（SSE 帧被截断）
  "unexpected end of input", // 同类的另一种措辞
  "premature close", // undici/node stream 提前关闭
  "incomplete chunked encoding", // chunked 传输未收到结束块
];

/**
 * 是否「网络 / 连接类故障」：有可重试的网络错误码，或文案命中连接被关闭 / 流被截断词表。
 *
 * `error-normalize.ts` 的 origin 判定第 2 步与分类器的已识别 network_error 都只调这一个函数，
 * 词表只在本文件维护一份。
 */
export function isNetworkFailure(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.includes(code)) return true;
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return RETRYABLE_CONNECTION_MESSAGES.some((frag) => msg.includes(frag));
}

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
 *
 * B5-3（§五之二 漏斗-3）：返回 `boolean | undefined`——`undefined` 表示 **header 不存在**
 * （服务端没表态），`false` 表示服务端**明确说别重试**。
 *
 * 旧签名是 `boolean`，把这两种情况压成同一个 `false`，于是 `classifyError` 只消费得了
 * "该重试"这一半，服务端明确要求停止时我们照样重试到上界。
 *
 * **这条对我们比对 CC 更要紧**：`x-should-retry` 不是标准 header，公司网关 / 中转层
 * 常用它表达"这个 key 就是错的、别打了"。忽略它 = 对着已知必然失败的请求打满 10 次
 * 退避（最坏 ~20 分钟纯烧配额），直接违背北极星的"更省"。
 *
 * 对照 CC `withRetry.ts:746-751`：显式处理 `'false'`，仅"内部用户 + 5xx"一个例外
 * （对应它自己的灰度需求，我们无此概念，故不照搬）。
 */
export function parseXShouldRetry(error: unknown): boolean | undefined {
  const headers = extractResponseHeaders(error);
  if (!headers) return undefined;

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

  // header 键不存在（headers 对象在、但没这个键）→ 与"整个 headers 缺失"同义：服务端没表态。
  if (value === null) return undefined;

  const lowered = (value as string).toLowerCase().trim();
  if (lowered === "true" || lowered === "yes" || lowered === "1") return true;
  if (lowered === "false" || lowered === "no" || lowered === "0") return false;
  // 值存在但无法解读（如 "maybe"）→ 不当作任何一方的表态，交回下游按状态码判定。
  // 判成 false 会让一个畸形 header 值把可重试错误变成 terminal——比忽略它更糟。
  return undefined;
}

/**
 * 从 response headers 解析 Retry-After（秒）。
 * 支持标准 Retry-After header 和自定义 retry-after 变体。
 */
export function parseRetryAfterFromHeaders(error: unknown): number | undefined {
  const headers = extractResponseHeaders(error);
  if (!headers) return undefined;

  // 用返回值而不是闭包写外层变量：闭包内的赋值不参与控制流收窄，
  // TS 会把外层 `value` 一路当成初始化时的 `null`，于是 `value !== null` 之后
  // 类型收窄成 `never`，`.trim()` 直接报错。
  const extractFrom = (h: Headers | Record<string, string>): string | null => {
    if (h instanceof Headers) {
      return h.get("retry-after");
    }
    const keys = Object.keys(h);
    for (const k of keys) {
      if (k.toLowerCase() === "retry-after") {
        return String(h[k]);
      }
    }
    return null;
  };
  const value = extractFrom(headers);

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

/**
 * 判断错误是否为 **runtime 级超时**（`AbortSignal.timeout` 到点时抛出的
 * `DOMException("...", "TimeoutError")`）。
 *
 * 判据是结构性字段 `name`，**不看消息文本**：runtime 的文案随引擎/版本/locale 变，
 * 而 `name` 是 WHATWG DOM 规范固定的（`AbortSignal.timeout` → `"TimeoutError"`）。
 * memory `stream-timeout-misclassified-as-cancel-rootcause` 记的就是靠文本判超时
 * 被一个措辞通用的错误抢先命中的事故。
 *
 * ## 它与 `isAbortError` 刻意**互斥**
 *
 * 两者结论相反且都必须成立：
 *   · `isAbortError(TimeoutError) === false` —— 它不是"用户/上层主动中断"，
 *     不该被当成取消而静默吞掉（那正是 §2.3.2 那类"任务中断、没有报错"的体感来源）；
 *   · `classifyError(TimeoutError)` = `RetryableError("timeout")` —— 它是**可自愈**的
 *     本地超时，该重试。
 * 这个互斥关系由 `tests/llm/fetch-absolute-timeout-classification.test.ts` 钉住。
 */
export function isRuntimeTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (!("name" in error)) return false;
  return String((error as { name?: unknown }).name ?? "") === "TimeoutError";
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
  ].some((fragment) => lowerMsg.includes(fragment));
}

/** 将原始中断错误标准化为 RequestAbortedError */
export function toAbortError(error?: unknown): RequestAbortedError {
  if (error instanceof RequestAbortedError) return error;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Request aborted";
  return new RequestAbortedError(message);
}

// ─── 细粒度错误检测谓词 ───

/**
 * 数字边界匹配的实现在 `status-digits.ts`。
 *
 * 为什么不留在本文件：`error-lexicon.ts`（重试分类与面板文案共用的那一份词表）
 * 也要用它，而本文件反过来依赖那份词表。实现留在这里就是一个环。
 * 事故记录与「两处判据必须共用同一个实现」的理由都写在那个文件的文件头，
 * 不要在这里再复制一份——复制就是下一次只修一边的起点。
 */
import { hasBoundaryDigits } from "./status-digits.ts";

export { hasBoundaryDigits };

/**
 * 408 / 409 / 401 这三个谓词的文本半边走共享词表（`error-lexicon.ts`），
 * 不再各写一份子串。`conflict` 的裸 `.includes` 曾把 `merge conflict` 判成
 * 409 锁超时——词边界匹配修的就是这个。
 *
 * 结构化状态码仍然优先：词表扫的是整句，一条 `409 ... upstream not found`
 * 不该因为后半句被判成模型不存在。状态码在场时直接看它。
 */
export function is408Error(error: unknown): boolean {
  const status = getHTTPStatus(error);
  if (status !== undefined) return status === 408;
  return matchErrorLexicon(messageOf(error)) === "request_timeout";
}

export function is409Error(error: unknown): boolean {
  const status = getHTTPStatus(error);
  if (status !== undefined) return status === 409;
  return matchErrorLexicon(messageOf(error)) === "lock_timeout";
}

export function is401Error(error: unknown): boolean {
  const status = getHTTPStatus(error);
  if (status !== undefined) return status === 401;
  // 不能直接复用词表的 auth_failed：词表把 403 与 401 归到同一个码（都不可自愈），
  // 而这个谓词的名字是 401。fallback.ts 拿它做「要不要走凭据刷新闸门」的判断，
  // 403（key 没权限 / 账号被禁用）刷新也没用，混进去会白刷一次。
  const msg = messageOf(error).toLowerCase();
  return (
    hasBoundaryDigits(msg, "401") ||
    msg.includes("authentication") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid x-api-key")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * 从错误信息中解析 Retry-After（秒 → 毫秒）
 * 优先匹配 headers，回退到消息正则提取
 */
export function parseRetryAfter(error: unknown): number | undefined {
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
