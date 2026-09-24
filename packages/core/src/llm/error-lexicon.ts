/**
 * 错误文案的**唯一**词表。
 *
 * `classifyError`（决定重不重试）与 `inferErrorCode`（决定面板文案）此前各写一份
 * 关键词，已经分叉过一次：UI 认得「当前分组上游负载已饱和」，重试分类器不认，
 * 于是同一条报文面板显示通用「运行错误」、重试侧零重试直接终止（smoke-8，
 * 2026-08-25）。`hasBoundaryDigits` 的导出注释记的就是同一类事故的前一半
 * （数字边界只修了一边）——关键词这半边当时没修，所以这次是它的第二次。
 *
 * 所以这里只有一份短语表，两个函数都调它。新增一条网关文案只改这一个文件。
 *
 * ## 匹配规则（改之前先读）
 *
 * - 英文短语按**词边界**匹配，不用裸子串。`capacity` 会命中 `capacities`。
 *   词边界挡不住本身就是完整单词的误伤：`conflict` 因此**不在**这张表里
 *   （`git merge conflict` 与 409 锁超时无关），409 只认 `lock timeout` 和状态码。
 *   边界含中文：JS 的 `\b` 把非 ASCII 当非单词字符，`负载capacity` 这种粘连
 *   会被 `\b` 放行，所以用自定义边界（前后不是字母也不是数字）。
 * - 中文没有词边界这个概念。`负载已饱和`、`余额不足` 这种多字短语用 `.includes`
 *   是安全的，不要为了统一硬套正则。
 * - 状态码数字一律走 `hasBoundaryDigits`。裸 `.includes("404")` 会把 request id
 *   `…1340438…` 里的 `404` 当成模型不存在（2026-07-13 生产事故）。
 * - 顺序是语义，不是风格。三条已经踩过的必须保持：
 *   1. `usage limit` 排在 `rate_limit` 之前（否则 "hit your session limit" 被当成瞬态）；
 *   2. `temporarily limiting` / `not your usage limit` 排在用量上限之前
 *      （官方明确说这不是配额，是短期限流）；
 *   3. `context_length_exceeded` 排在裸 `400` 之前
 *      （否则用户被指引去改 maxTokens，而正解是 /compact）。
 *
 * ## 这个模块刻意不依赖 errors.ts
 *
 * `errors.ts` 要调这里，`error-messages.ts` 也要调这里。如果词表反过来 import
 * 那两个文件里的任何一个，就成环。所以本文件不引用 `TerminalReason` /
 * `RetryableReason`，码是字面量字符串；两个消费方各自用 `satisfies` 把它钉回枚举。
 */

import { hasBoundaryDigits } from "./status-digits.ts";

/**
 * 词表能产出的全部错误码。
 *
 * 前两段与 `errors.ts` 的 `TerminalReason` / `RetryableReason` 一一对应——
 * 那是重试决策真正消费的部分。后一段只给面板用：重试分类器对它们返回
 * `undefined`（认不出），保持 fail-fast，不把「上下文太长」这类确定性故障
 * 拖进 10 次退避。
 */
export type LexiconCode =
  // 终端（不重试）
  | "auth_failed"
  | "model_not_found"
  | "quota_exhausted"
  | "content_policy"
  | "invalid_request"
  | "usage_limit_reached"
  // 可重试
  | "rate_limit"
  | "overloaded"
  | "request_timeout"
  | "lock_timeout"
  | "server_error"
  | "timeout"
  | "network_error"
  // 只给面板，重试分类器不消费
  | "context_overflow"
  | "no_finish_reason"
  | "html_error_page"
  | "empty_response"
  | "unknown_stop_reason"
  | "subagent_failed";

/** 重试分类器消费的码：面板专属码不在其中。 */
export type ClassifierLexiconCode = Exclude<
  LexiconCode,
  | "context_overflow"
  | "no_finish_reason"
  | "html_error_page"
  | "empty_response"
  | "unknown_stop_reason"
  | "subagent_failed"
>;

const CLASSIFIER_CODES: ReadonlySet<string> = new Set<ClassifierLexiconCode>([
  "auth_failed",
  "model_not_found",
  "quota_exhausted",
  "content_policy",
  "invalid_request",
  "usage_limit_reached",
  "rate_limit",
  "overloaded",
  "request_timeout",
  "lock_timeout",
  "server_error",
  "timeout",
  "network_error",
]);

export function isClassifierLexiconCode(code: LexiconCode): code is ClassifierLexiconCode {
  return CLASSIFIER_CODES.has(code);
}

interface Phrase {
  /** 英文短语，按词边界匹配。 */
  word?: string;
  /** 中文短语，按子串匹配。 */
  text?: string;
}

function phrase(p: Phrase): Phrase {
  return p;
}

/**
 * 英文短语的词边界：前后都不是 ASCII 字母或数字。
 *
 * 不用 `\b`：它对中文这种非 ASCII 字符恒为真，`负载capacity已满` 会被当成命中。
 * 网关文案中英混排是常态，这个边界必须把中文也当「在词内」。
 */
function matchesWord(lower: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:[^A-Za-z0-9]|$)`).test(lower);
}

function matches(lower: string, p: Phrase): boolean {
  if (p.word !== undefined) return matchesWord(lower, p.word);
  if (p.text !== undefined) return lower.includes(p.text);
  return false;
}

function anyOf(lower: string, phrases: readonly Phrase[]): boolean {
  return phrases.some((p) => matches(lower, p));
}

/**
 * 从错误消息文本推断错误码。找不到返回 undefined —— 调用方的契约是
 * 「认不出就保持原样」，不要在这里发明一个兜底码。
 *
 * `msg` 不要求预先小写：本函数自己转。状态码扫描走数字边界，大小写无关。
 */
export function matchErrorLexicon(msg: string): LexiconCode | undefined {
  if (!msg) return undefined;
  const lower = msg.toLowerCase();

  // ── 1. 短期限流，必须在用量上限之前 ──
  // 官方原文 `Server is temporarily limiting requests (not your usage limit)`
  // 含 "usage limit" 这个子串，但页面写明它与计划配额无关、会自动退避。
  // 判据取整句否定语，比调分支顺序更稳（顺序对时它仍含那个子串）。
  if (
    anyOf(lower, [
      phrase({ word: "temporarily limiting" }),
      phrase({ word: "not your usage limit" }),
    ])
  ) {
    return "rate_limit";
  }

  // ── 2. 用量到顶（终端）。必须在 rate_limit 之前："hit your session limit" 含 "limit" ──
  if (
    anyOf(lower, [
      phrase({ word: "hit your session limit" }),
      phrase({ word: "hit your weekly limit" }),
      phrase({ word: "hit your opus limit" }),
      phrase({ word: "usage limit" }),
      phrase({ word: "usage credits required" }),
      phrase({ text: "用量上限" }),
      phrase({ text: "额度已用尽" }),
    ])
  ) {
    return "usage_limit_reached";
  }

  // ── 3. 上下文溢出。必须在裸 400 之前：上游常以 400 回它，归 invalid_request
  //       会把用户引去改 maxTokens，正解是 /compact ──
  if (
    anyOf(lower, [
      phrase({ word: "prompt is too long" }),
      phrase({ word: "conversation too long" }),
      phrase({ word: "request too large" }),
      phrase({ word: "context window" }),
      phrase({ word: "context_length_exceeded" }),
      phrase({ word: "maximum context length" }),
      phrase({ word: "too many tokens" }),
    ]) ||
    (lower.includes("上下文") && lower.includes("超出"))
  ) {
    return "context_overflow";
  }

  // ── 4. 认证失败 ──
  if (
    anyOf(lower, [
      phrase({ word: "unauthorized" }),
      phrase({ word: "invalid api key" }),
      phrase({ word: "invalid x-api-key" }),
      phrase({ word: "api key" }),
      phrase({ word: "not logged in" }),
      phrase({ word: "login expired" }),
      phrase({ word: "could not resolve authentication" }),
      phrase({ word: "failed to authenticate" }),
      phrase({ word: "authentication failed" }),
      phrase({ word: "authentication_error" }),
      phrase({ word: "authentication error" }),
      phrase({ word: "oauth token" }),
      phrase({ word: "apikeyhelper" }),
      phrase({ word: "organization has been disabled" }),
      phrase({ word: "organization has disabled" }),
      phrase({ word: "credentials expired" }),
      phrase({ word: "scope requirement" }),
      phrase({ word: "x-api-key header is required" }),
      phrase({ word: "no auth credentials" }),
    ]) ||
    hasBoundaryDigits(lower, "401") ||
    hasBoundaryDigits(lower, "403")
  ) {
    return "auth_failed";
  }

  // ── 5. 模型不存在 ──
  // 刻意**不含**裸 "not found"：它会把 "upstream not found" / "no available channel
  // ... not found" 这类可重试的 5xx 误判成终端（与 request id 里的 404 是同类事故）。
  if (
    anyOf(lower, [
      phrase({ word: "model_not_found" }),
      phrase({ word: "model not found" }),
      phrase({ word: "does not exist" }),
      phrase({ word: "not a recognized model id" }),
      phrase({ word: "issue with the selected model" }),
      phrase({ word: "is not available with the claude" }),
      phrase({ word: "restricted by your organization" }),
    ]) ||
    hasBoundaryDigits(lower, "404")
  ) {
    return "model_not_found";
  }

  // ── 6. 欠费（终端）。402 与「余额不足」一个都不能漏：重试一万次也是欠费 ──
  if (
    anyOf(lower, [
      phrase({ word: "quota" }),
      phrase({ word: "insufficient_quota" }),
      phrase({ word: "insufficient balance" }),
      phrase({ word: "billing" }),
      phrase({ word: "credit balance" }),
      phrase({ text: "余额不足" }),
      phrase({ text: "欠费" }),
      phrase({ text: "请充值" }),
    ]) ||
    hasBoundaryDigits(lower, "402")
  ) {
    return "quota_exhausted";
  }

  // ── 7. 内容策略。排在 usage_limit 之后："usage policy" 含 "usage"，靠整词区分 ──
  if (
    anyOf(lower, [
      phrase({ word: "content_policy" }),
      phrase({ word: "content filter" }),
      phrase({ word: "content_filter" }),
      phrase({ word: "safety" }),
      phrase({ word: "usage policy" }),
      phrase({ word: "violate our" }),
    ])
  ) {
    return "content_policy";
  }

  // ── 8. 请求本身不合法（终端）──
  if (
    anyOf(lower, [
      phrase({ word: "invalid_request" }),
      phrase({ word: "invalid request" }),
      phrase({ word: "too large" }),
      phrase({ word: "password protected" }),
      phrase({ word: "unable to resize" }),
      phrase({ word: "extra inputs are not permitted" }),
      phrase({ word: "is not supported for this model" }),
      phrase({ word: "must be greater than" }),
    ]) ||
    hasBoundaryDigits(lower, "400") ||
    hasBoundaryDigits(lower, "422")
  ) {
    return "invalid_request";
  }

  // ── 9. 限流（可重试）──
  // 中文三条是网关实测文案：smoke-8 的「当前分组上游负载已饱和」既无 429 也无
  // "rate limit"，只靠结构化 code 才没炸。code 缺失时必须仍能认出来。
  if (
    anyOf(lower, [
      phrase({ word: "rate_limit" }),
      phrase({ word: "rate limit" }),
      phrase({ word: "too many requests" }),
      phrase({ text: "负载已饱和" }),
      phrase({ text: "请求过于频繁" }),
      phrase({ text: "请求频率" }),
    ]) ||
    hasBoundaryDigits(lower, "429")
  ) {
    return "rate_limit";
  }

  // ── 10. 过载（可重试）──
  // `capacity` 走词边界：裸子串会命中 `capacities`。
  if (
    anyOf(lower, [
      phrase({ word: "overloaded" }),
      phrase({ word: "insufficient_system_resource" }),
      phrase({ word: "at capacity" }),
      phrase({ word: "capacity" }),
    ]) ||
    hasBoundaryDigits(lower, "529") ||
    hasBoundaryDigits(lower, "503")
  ) {
    return "overloaded";
  }

  // ── 11. 408 / 409 ──
  // 刻意**不含** `conflict` 这个词。它是完整的英文单词，词边界也挡不住
  // `git merge conflict`，而那种报文与 409 锁超时毫无关系（errors.ts 旧的
  // is409Error 用裸 `.includes("conflict")`，踩的就是这个）。409 只认
  // `lock timeout` 和带数字边界的状态码本身。
  if (
    anyOf(lower, [phrase({ word: "http 408" }), phrase({ word: "status 408" })]) ||
    hasBoundaryDigits(lower, "408")
  ) {
    return "request_timeout";
  }
  if (
    anyOf(lower, [
      phrase({ word: "lock timeout" }),
      phrase({ word: "http 409" }),
      phrase({ word: "status 409" }),
    ]) ||
    hasBoundaryDigits(lower, "409")
  ) {
    return "lock_timeout";
  }

  // ── 12. 流中途断开。归 no_finish_reason（面板专属，已在瞬态集合里）──
  // 放在 server_error 之前：这三条含 "server error" 字样，落到 server_error 也算瞬态，
  // 但 no_finish_reason 的文案才准确说明「响应可能不完整」。
  if (
    anyOf(lower, [
      phrase({ word: "mid-response" }),
      phrase({ word: "mid-stream" }),
      phrase({ word: "response stalled" }),
      phrase({ word: "connection closed" }),
    ])
  ) {
    return "no_finish_reason";
  }

  // ── 13. 网关回了 HTML 错误页 ──
  if (
    anyOf(lower, [
      phrase({ word: "text/html" }),
      phrase({ text: "错误页" }),
      phrase({ word: "no available channel" }),
    ])
  ) {
    return "html_error_page";
  }

  // ── 14. 空响应 ──
  if (
    anyOf(lower, [
      phrase({ text: "空响应" }),
      phrase({ word: "empty_response" }),
      phrase({ text: "0 内容事件" }),
    ])
  ) {
    return "empty_response";
  }

  // ── 15. 超时 ──
  if (
    anyOf(lower, [
      phrase({ word: "timeout" }),
      phrase({ word: "timed out" }),
      phrase({ word: "etimedout" }),
      phrase({ text: "超时" }),
    ])
  ) {
    return "timeout";
  }

  // ── 16. 网络 ──
  if (
    anyOf(lower, [
      phrase({ word: "network" }),
      phrase({ word: "econnrefused" }),
      phrase({ word: "enotfound" }),
      phrase({ word: "fetch failed" }),
      phrase({ word: "unable to connect" }),
      phrase({ word: "ssl certificate" }),
      phrase({ word: "certificate verification" }),
      phrase({ word: "econnreset" }),
      phrase({ word: "socket hang up" }),
    ])
  ) {
    return "network_error";
  }

  // ── 17. 5xx 服务端错误 ──
  if (
    anyOf(lower, [phrase({ word: "server_error" }), phrase({ word: "internal server error" })]) ||
    hasBoundaryDigits(lower, "500") ||
    hasBoundaryDigits(lower, "502") ||
    hasBoundaryDigits(lower, "504")
  ) {
    return "server_error";
  }

  // ── 18. 未识别的停止原因 ──
  if (anyOf(lower, [phrase({ text: "未识别的停止原因" }), phrase({ word: "unknown stop" })])) {
    return "unknown_stop_reason";
  }

  // ── 19. 子代理提前终止。放最后：它的 detail 里通常还有更具体的根因 ──
  if (anyOf(lower, [phrase({ word: "terminated early" }), phrase({ word: "agent terminated" })])) {
    return "subagent_failed";
  }

  return undefined;
}
