import { hasBoundaryDigits } from "./errors.ts";

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
    suggestion:
      "请检查 ~/.sid-code/settings.json 中的 apiKey 配置，或确认环境变量 OPENAI_API_KEY / ANTHROPIC_API_KEY 是否正确设置",
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
    suggestion:
      "上游返回 x-should-retry: false（常见于网关判定 API Key 无效或线路不可用），已停止重试以免浪费配额。请检查 apiKey 与 baseURL 配置，或切换 provider / fallbackModel",
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

  // ─── 用量限额与上下文溢出（2026-09-06 补，对齐 cc 官方错误参考页）───
  //
  // 为什么这两个值得单独立码、而其余官方文案一律复用既有码：判据是**用户的下一步动作**。
  // 「用量到顶」要等重置窗口或换 provider（重试无用、充值也不一定有用）；
  // 「上下文溢出」要 /compact 或删附件（重试必然再失败）。这两个动作都不是既有码能表达的。
  // 反例：`Invalid API key` / `OAuth token expired` / `AWS authentication failed` 的
  // 下一步动作都是"去修凭据"，全部归 auth_failed 即可 —— 为每种措辞立一个码
  // 只会把文案表撑大，而用户看到的建议一模一样。
  usage_limit_reached: {
    title: "已达用量上限",
    suggestion:
      "当前额度已用尽（会话 / 周 / 特定模型窗口）。请等待额度重置，或用 /model 切换到其它模型 / provider",
  },
  context_overflow: {
    title: "请求超出上下文窗口",
    suggestion:
      "对话或单条请求超出模型上下文上限。请用 /compact 压缩对话、开新会话，或移除过大的文件 / 图片附件后重试",
  },

  // ─── 自定义扩展码（非 errors.ts 枚举，但实际出现的场景）───
  subagent_failed: {
    title: "子代理执行失败",
    suggestion: "请检查子代理使用的模型是否可用，或重试当前操作",
  },
  html_error_page: {
    title: "网关返回非流式错误页",
    suggestion:
      "网关对当前模型/渠道返回了 HTML 错误页（而非 SSE 流）。请确认模型 ID 与网关配置一致",
  },
  unknown_stop_reason: {
    title: "模型以未识别的停止原因结束",
    suggestion: "若回答不完整，请重新发送消息继续",
  },
};

/**
 * 由**结构化**字段（HTTP 状态码 + 上游 error.type）解析分类码 —— 优先于文本推断。
 *
 * 为什么必须有这一层（2026-09-06）：`inferErrorCode` 是关键词匹配，两个方向都会错。
 * 猜不出：网关真实文本「当前分组上游负载已饱和，请稍后再试 (request id: …)」既无
 * "429" 也无 "rate limit"，实测返回 undefined → 面板退化成通用「运行错误」
 * （轨迹 20260905-215535-664d3239，而同一份 RetryTelemetry 里明明写着 rate_limit）。
 * 猜错：request id / trace id / 耗时数字里巧合含状态码。
 *
 * 而这两个字段是**上游明确给出的**，不需要猜。取数链路见 llm/errors.ts 的
 * LLMStreamError：流内 error 事件 → throw 时随异常带出 → fatal_error.errorCode → 本函数。
 *
 * 返回 undefined 表示"结构化信息不足"，调用方应回落 inferErrorCode，而不是当成"无错误"。
 */
export function codeFromStructured(statusCode?: number, errorType?: string): string | undefined {
  // error.type 比状态码更具体（同一个 400 可能是 invalid_request 也可能是 content_policy），
  // 故先判它。空串/未知 type 不算命中，继续往下看状态码。
  const type = (errorType ?? "").toLowerCase();
  if (type) {
    if (type.includes("overloaded")) return "overloaded";
    if (type.includes("rate_limit")) return "rate_limit";
    if (type.includes("authentication")) return "auth_failed";
    if (type.includes("permission")) return "auth_failed";
    if (type.includes("not_found")) return "model_not_found";
    if (type.includes("invalid_request")) return "invalid_request";
    if (type.includes("content_policy") || type.includes("content_filter")) return "content_policy";
    if (type.includes("insufficient_quota") || type.includes("billing")) return "quota_exhausted";
    if (type.includes("timeout")) return "timeout";
    if (type.includes("api_error") || type.includes("server_error")) return "server_error";
  }

  switch (statusCode) {
    case 401:
    case 403:
      return "auth_failed";
    // 402 Payment Required：网关族用它表达余额耗尽（deepseek 已实测欠费走这条）。
    case 402:
      return "quota_exhausted";
    case 404:
      return "model_not_found";
    case 408:
      return "request_timeout";
    case 409:
      return "lock_timeout";
    case 400:
    case 422:
      return "invalid_request";
    case 429:
      return "rate_limit";
    case 503:
    case 529:
      return "overloaded";
    case 500:
    case 502:
    case 504:
      return "server_error";
    default:
      return undefined;
  }
}

/**
 * 从错误消息文本推断 errorCode。
 * 策略：按关键词逐条匹配，返回第一个命中的 code。
 * 找不到时返回 undefined（调用方可 fallback 到通用错误）。
 */
export function inferErrorCode(message: string): string | undefined {
  if (!message) return undefined;
  const lower = message.toLowerCase();

  // 优先级从高到低（越具体越靠前）

  // 用量上限（2026-09-06）：**必须排在 rate_limit 之前**。
  // "You've hit your session limit" 里含 "limit"，若先落到 rate_limit 分支，
  // 它就会被 isTransientErrorCode 判成瞬态 → 请求一恢复就自动清掉卡片；
  // 而用量到顶需要用户等重置或换模型，属于必须留在界面上的终态错误。
  // 顺序在这里是**语义正确性**问题，不是风格问题。
  // 反例先挡（2026-09-06）：官方文案
  // `Server is temporarily limiting requests (not your usage limit)` 里含 "usage limit"
  // 这个子串，但页面明确写着它**与计划配额无关**，是短期限流且会自动退避重试。
  // 若被下面的 usage_limit_reached 吃掉，就会当成终态错误——卡片永久挂着不自动消失，
  // 而实际请求早已恢复。这正是本仓库修过一次的「限流卡片不消失」同形缺陷。
  // 判据取"整句否定语"，比调分支顺序更稳（顺序对时它仍含那个子串）。
  if (lower.includes("temporarily limiting") || lower.includes("not your usage limit")) {
    return "rate_limit";
  }

  if (
    lower.includes("hit your session limit") ||
    lower.includes("hit your weekly limit") ||
    lower.includes("hit your opus limit") ||
    lower.includes("usage limit") ||
    lower.includes("usage credits required") ||
    lower.includes("用量上限") ||
    lower.includes("额度已用尽")
  ) {
    return "usage_limit_reached";
  }

  // 上下文溢出：也要排在 invalid_request（含裸 400 判定）之前 —— 上游常以 400 回它，
  // 归成"请求参数错误"会把用户引到检查 maxTokens/temperature，而正解是 /compact。
  if (
    lower.includes("prompt is too long") ||
    lower.includes("conversation too long") ||
    lower.includes("request too large") ||
    lower.includes("context window") ||
    lower.includes("context_length_exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("too many tokens") ||
    (lower.includes("上下文") && lower.includes("超出"))
  ) {
    return "context_overflow";
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("api key") ||
    // cc 官方错误参考页的认证族措辞（2026-09-06）：下一步动作都是「去修凭据」，
    // 故一律归 auth_failed，不为每种措辞立新码。
    lower.includes("not logged in") ||
    lower.includes("login expired") ||
    lower.includes("could not resolve authentication") ||
    lower.includes("failed to authenticate") ||
    lower.includes("authentication failed") ||
    lower.includes("oauth token") ||
    lower.includes("apikeyhelper") ||
    lower.includes("organization has been disabled") ||
    lower.includes("organization has disabled") ||
    lower.includes("credentials expired") ||
    lower.includes("scope requirement")
  ) {
    return "auth_failed";
  }
  if (
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("does not exist") ||
    // 官方页模型族措辞（2026-09-06）：下一步动作都是「改 model 配置」→ 同一个码。
    lower.includes("not a recognized model id") ||
    lower.includes("issue with the selected model") ||
    lower.includes("is not available with the claude") ||
    lower.includes("restricted by your organization")
  ) {
    return "model_not_found";
  }
  // 402 与「余额不足」措辞（2026-09-06 补）：网关族把配额耗尽表达成 402 +
  // `Insufficient Balance` / `余额不足`，一个都不在原关键词表里 —— 实测
  // `"402 当前分组余额不足，请充值后再试"` 与 `"Insufficient Balance"` 双双返回
  // undefined，于是面板标题退化成通用「运行错误」，用户看不出这是要去充值。
  if (
    lower.includes("quota") ||
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient balance") ||
    lower.includes("billing") ||
    lower.includes("余额不足") ||
    lower.includes("欠费") ||
    lower.includes("请充值") ||
    lower.includes("credit balance") ||
    hasBoundaryDigits(lower, "402")
  ) {
    return "quota_exhausted";
  }
  if (
    lower.includes("content_policy") ||
    lower.includes("content filter") ||
    lower.includes("safety") ||
    // 官方拒答文案（2026-09-06）："...appears to violate our Usage Policy"。
    // 注意与 usage_limit_reached 的区分：那条是额度用尽，这条是内容被拒 ——
    // 两者都含 "usage"，靠 "usage policy" 整词区分，故本分支必须排在
    // usage_limit_reached 之后（它先判 "usage limit"，不会抢走 "usage policy"）。
    lower.includes("usage policy") ||
    lower.includes("violate our")
  ) {
    return "content_policy";
  }
  if (
    lower.includes("invalid_request") ||
    lower.includes("invalid request") ||
    // 官方「请求本身不合法」族（2026-09-06）：附件过大 / 参数不被模型支持 /
    // 多余字段。下一步动作都是「改请求」（换小图、去附件、改 thinking 配置），
    // 与 context_overflow 的 /compact 不同，故不并入那个码。
    lower.includes("too large") ||
    lower.includes("password protected") ||
    lower.includes("unable to resize") ||
    lower.includes("extra inputs are not permitted") ||
    lower.includes("is not supported for this model") ||
    lower.includes("must be greater than") ||
    hasBoundaryDigits(lower, "400")
  ) {
    return "invalid_request";
  }
  // 网关中文限流措辞（2026-09-06 补）：本次事故的直接原因就在这里。真实文本是
  // 「当前分组上游负载已饱和，请稍后再试 (request id: …)」—— 既无 "429" 也无
  // "rate limit"，实测 inferErrorCode 返回 undefined，面板于是显示通用「运行错误」，
  // 而 RetryTelemetry 里明明记着 reopenReason:"rate_limit"。
  // 结构化 code 才是首选判据（见 lookupErrorMessage 的 code 参数），这里是文本兜底。
  if (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("负载已饱和") ||
    lower.includes("请求过于频繁") ||
    lower.includes("请求频率") ||
    hasBoundaryDigits(lower, "429")
  ) {
    return "rate_limit";
  }

  if (
    lower.includes("overloaded") ||
    // "at capacity" / "temporary capacity issue"（官方 529 与 429 文案都用它）。
    // 收敛 classifyRetryKind 时从那边的正则带过来的，别再丢。
    lower.includes("capacity") ||
    hasBoundaryDigits(lower, "529") ||
    hasBoundaryDigits(lower, "503")
  ) {
    return "overloaded";
  }
  // 流中途断开（2026-09-06）：官方三条文案 "Server error mid-response" /
  // "Connection closed mid-response" / "Response stalled mid-stream"。
  // 归 no_finish_reason（已在瞬态集合里）—— 系统自动重试，恢复后卡片自动消失。
  // 放在 server_error 之前：这三条含 "server error" 字样，落到 server_error 也算瞬态，
  // 但 no_finish_reason 的文案才准确说明"响应可能不完整"。
  if (
    lower.includes("mid-response") ||
    lower.includes("mid-stream") ||
    lower.includes("response stalled") ||
    lower.includes("connection closed")
  ) {
    return "no_finish_reason";
  }
  if (
    lower.includes("text/html") ||
    lower.includes("错误页") ||
    lower.includes("no available channel")
  ) {
    return "html_error_page";
  }
  if (
    lower.includes("空响应") ||
    lower.includes("empty_response") ||
    lower.includes("0 内容事件")
  ) {
    return "empty_response";
  }
  if (lower.includes("timeout") || lower.includes("超时") || lower.includes("timed out")) {
    return "timeout";
  }
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    // 官方网络族措辞（2026-09-06）。SSL 证书失败也归这里：下一步都是「查网络 / 代理 / 证书链」，
    // 且它同属"重试可能有用"的瞬态类（企业网关证书抖动实测会自愈）。
    lower.includes("unable to connect") ||
    lower.includes("ssl certificate") ||
    lower.includes("certificate verification") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up")
  ) {
    return "network_error";
  }
  if (
    hasBoundaryDigits(lower, "500") ||
    hasBoundaryDigits(lower, "502") ||
    lower.includes("internal server error")
  ) {
    return "server_error";
  }
  if (lower.includes("未识别的停止原因") || lower.includes("unknown stop")) {
    return "unknown_stop_reason";
  }
  // 子代理因 API 错误提前终止（2026-09-06，官方文案 "Agent terminated early due to an
  // API error"）。放在最后：它的 <error detail> 里通常还带更具体的根因（429/500…），
  // 让前面那些更精确的分支优先命中，这里只兜"detail 也说不清"的情况。
  if (lower.includes("terminated early") || lower.includes("agent terminated")) {
    return "subagent_failed";
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
