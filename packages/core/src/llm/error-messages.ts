import { matchErrorLexicon } from "./error-lexicon.ts";

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
/**
 * 从错误消息文本推断 errorCode。
 *
 * 实现就是 `error-lexicon.ts` 那一份共享词表 —— `classifyError` 用的是同一个
 * 函数。此前这里自带一份关键词，两份已经分叉过：面板认得「负载已饱和」，
 * 重试分类器不认，同一条报文一边显示通用「运行错误」、一边零重试终止整轮。
 *
 * 顺序、词边界、数字边界的三条铁律都写在词表文件头，改文案去那里改，
 * 不要在这里再加一个 `if (lower.includes(...))`。
 */
export function inferErrorCode(message: string): string | undefined {
  if (!message) return undefined;
  return matchErrorLexicon(message);
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
