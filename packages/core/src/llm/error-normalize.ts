/**
 * LLM 错误归一化 + 唯一分类器（2026-10-08「一次判死」根治，设计 §4.1）。
 *
 * ── 为什么要有这一层 ──
 *
 * 同一个错误有两种到达形态：provider **抛出**异常（throw），或把它转成**流内 `error` 事件**
 * yield 出来（anthropic 族把 HTTP 异常全转成事件，openai 族 `!response.ok` 同样如此）。
 * 此前两种形态各走一个分类器（`classifyError` 兜底「无法分类 → 零重试」，
 * `classifyStreamError` 兜底「按 server_error 重试」），于是 520 系列一边零重试一边重试，
 * 「首个 401 重试一次」的闸门只在 catch 里、事件路径上根本不生效
 * （会话 20261008-173228-baeb949d：`Token已失效，请重试` 5ms 内判死，零重试）。
 *
 * 现在两种形态先变成同一个 `NormalizedLLMError`，再交给同一个 `classifyFamily`。
 * `arrival` 字段只进遥测，⛔ 不得参与任何决策——参与决策就回到了双路径分叉。
 *
 * ── 分类器的职责被降级了 ──
 *
 * `classifyFamily` 的结论叫**错误族**，只用来查「退避节奏和预算」（见 recovery-policy.ts），
 * 不决定生死。认不出的错误默认进 `transient`（未识别子集），而不是「无法分类 → 不重试」。
 * 所以分类器漏认一种网关措辞，代价是「多试几次」而不是「整轮判死」。
 */

import {
  RetryableError,
  StreamValidationError,
  getHTTPStatus,
  getNetworkErrorCode,
  isNetworkFailure,
  isRuntimeTimeoutError,
  parseRetryAfter,
  parseXShouldRetry,
  type RetryableReason,
  type StreamValidationReason,
  type SuspectReason,
} from "./errors.ts";
import { isClassifierLexiconCode, matchErrorLexicon } from "./error-lexicon.ts";

/** 来源：network/http = 来自传输层或上游响应；local = 本地抛出的 JS 异常 */
export type ErrorOrigin = "network" | "http" | "local";

export interface NormalizedLLMError {
  /** 原始错误（保留给日志与 SDK 字段读取，如 Retry-After header） */
  raw: unknown;
  /** 结构化 HTTP 状态码；拿不到为 undefined */
  status?: number;
  /** 上游结构化 type / code（anthropic error.type、openai error.code、网关扩展 code） */
  upstreamType?: string;
  /** 展示用文案（优先上游人类可读 message） */
  message: string;
  /** 服务端重试提示（x-should-retry），拿不到为 undefined */
  serverRetryHint?: boolean;
  /** 判定规则见 `resolveOrigin` */
  origin: ErrorOrigin;
  /** 到达形态：仅用于遥测，⛔ 不得参与决策 */
  arrival: "thrown" | "stream_event";
  /** status + upstreamType + 归一化 message 的稳定 hash（去掉 request id、数字、时间戳） */
  fingerprint: string;
  /**
   * 上游/本地已经给出的**结构化**可重试原因（`RetryableError.reason`，或漏斗自己判出的
   * 流超时）。它是本地代码明确说过的事实，不是猜文案，故分类器直接采信。
   */
  presetReason?: RetryableReason;
  /** 服务端建议的等待时长（Retry-After / RetryableError.retryAfterMs） */
  retryAfterMs?: number;
  /** 流内容校验失败（空响应等）。空响应是非流式降级唯一能治的那类，决策要单独认它 */
  validation?: StreamValidationReason;
}

/** 流内 `error` 事件的载荷（`StreamEvent` 里 `type:"error"` 的 `error` 字段） */
export interface StreamErrorPayload {
  message: string;
  type?: string;
  statusCode?: number;
  streamLevel?: boolean;
}

/**
 * 事件分支把归一化结果「扔」进 catch 用的载体。
 *
 * 事件分支只做「归一化 + throw」（I3 单一决策点）：决策、计数、拉黑全在 catch 里那一处。
 * 用专门的类而不是普通 Error，是为了 catch 侧能**原样**拿回归一化结果，不再二次猜一遍。
 */
export class NormalizedErrorCarrier extends Error {
  constructor(public readonly normalized: NormalizedLLMError) {
    super(normalized.message);
    this.name = "NormalizedErrorCarrier";
  }
}

// ─── 指纹 ───

/**
 * 归一化文案后算 hash：去掉 request id / trace id、十六进制串、数字、多余空白。
 *
 * 目的是让「同一个故障」在多次尝试里得到同一个指纹（网关每次回的 request id 都不同），
 * 而「换了一种故障」得到不同指纹——判死的依据正是「同一指纹在有间隔的多次尝试里一直复现」。
 * 状态码不参与「去数字」：它单独作为指纹的一段。
 */
export function normalizeMessageForFingerprint(message: string): string {
  return message
    .toLowerCase()
    .replace(/\(?\s*(request|trace)[\s_-]?id\s*[:=]?\s*[\w-]+\s*\)?/g, " ")
    .replace(/\b[0-9a-f]{8,}\b/g, " ")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function computeFingerprint(
  status: number | undefined,
  upstreamType: string | undefined,
  message: string,
): string {
  return djb2(`${status ?? "-"}|${upstreamType ?? "-"}|${normalizeMessageForFingerprint(message)}`);
}

// ─── origin 判定 ───

const LOCAL_ERROR_TYPES = [TypeError, ReferenceError, SyntaxError, RangeError];

/**
 * origin 判定规则（设计 §4.2，顺序是契约）：
 *  1. 有结构化 status → http；
 *  2. 有网络错误码，或文案命中网络/连接词表，或是 runtime TimeoutError → network；
 *  3. 原始错误是 TypeError / ReferenceError / SyntaxError / RangeError 实例 → local；
 *  4. 其余 → network（按认不出处理）。
 * 不读 arrival：流内事件不是 JS 异常实例，天然到不了第 3 步——这是事实，不是规则。
 */
function resolveOrigin(raw: unknown, status: number | undefined, message: string): ErrorOrigin {
  if (status !== undefined) return "http";
  // ⛔ 必须先于下面的 TypeError 判定：Bun 的 fetch 网络失败也是 TypeError（设计 §2.7 实测）。
  if (
    getNetworkErrorCode(raw) ||
    isNetworkFailure(raw ?? message) ||
    isNetworkFailure(message) ||
    isRuntimeTimeoutError(raw)
  ) {
    return "network";
  }
  if (LOCAL_ERROR_TYPES.some((T) => raw instanceof T)) return "local";
  return "network";
}

// ─── 归一化入口 ───

function pickTag(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" && v !== "error" ? v : undefined;
}

/** SDK 异常（Anthropic / OpenAI APIError）把上游 body 挂在 `.error` 上 */
function extractUpstreamType(raw: unknown): string | undefined {
  const r = raw as {
    error?: { type?: unknown; code?: unknown; error?: { type?: unknown; code?: unknown } };
  };
  return (
    pickTag(r?.error?.error?.type) ??
    pickTag(r?.error?.error?.code) ??
    pickTag(r?.error?.type) ??
    pickTag(r?.error?.code)
  );
}

function messageOf(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "string") return raw;
  return String(raw ?? "");
}

/**
 * 归一化**抛出**的错误。
 *
 * @param opts.streamTimeoutMessage 漏斗自己的流超时 abort（不是用户中断）：
 *   它是本地明确知道的事实，直接按 `timeout` 预置原因，不靠文案。
 */
export function normalizeThrown(
  raw: unknown,
  opts: { streamTimeoutMessage?: string } = {},
): NormalizedLLMError {
  if (raw instanceof NormalizedErrorCarrier) return raw.normalized;

  if (opts.streamTimeoutMessage !== undefined) {
    const message = opts.streamTimeoutMessage;
    // 流超时是传输层事实。⚠️ 不在对象字面量里直接写 origin 键加字符串值：context 的
    // origin 防漂移哨兵按该形态正则扫全仓，会把错误来源误认成 `_meta.origin` 注入点。
    const origin: ErrorOrigin = "network";
    return {
      raw,
      message,
      origin,
      arrival: "thrown",
      presetReason: "timeout",
      fingerprint: computeFingerprint(undefined, "stream_timeout", message),
    };
  }

  const message = messageOf(raw);
  const status = getHTTPStatus(raw);
  const upstreamType = extractUpstreamType(raw);
  const n: NormalizedLLMError = {
    raw,
    status,
    upstreamType,
    message,
    serverRetryHint: parseXShouldRetry(raw),
    origin: resolveOrigin(raw, status, message),
    arrival: "thrown",
    fingerprint: computeFingerprint(status, upstreamType, message),
  };
  if (raw instanceof RetryableError) {
    n.presetReason = raw.reason;
    if (raw.retryAfterMs) n.retryAfterMs = raw.retryAfterMs;
    if (raw.serverInstructedRetry) n.serverRetryHint = true;
  } else if (raw instanceof StreamValidationError) {
    n.validation = raw.reason;
  } else if (isRuntimeTimeoutError(raw)) {
    n.presetReason = "timeout";
  }
  const retryAfter = n.retryAfterMs ?? parseRetryAfter(raw);
  if (retryAfter) n.retryAfterMs = retryAfter;
  return n;
}

/**
 * 归一化**流内 error 事件**。
 *
 * `streamLevel` 只影响「要不要采信 type 字段」吗？不：type 一律采信（为空/`"error"` 时丢弃），
 * `streamLevel` 在这里**不起任何作用**。保留入参只为调用方原样传事件载荷——
 * 它曾经是「选哪个分类器」的开关，那正是双路径分叉的来源。
 */
export function normalizeStreamEvent(payload: StreamErrorPayload): NormalizedLLMError {
  const message = payload.message ?? "";
  const status = typeof payload.statusCode === "number" ? payload.statusCode : undefined;
  const upstreamType = pickTag(payload.type);
  const raw =
    status !== undefined ? Object.assign(new Error(message), { status }) : new Error(message);
  const n: NormalizedLLMError = {
    raw,
    status,
    upstreamType,
    message,
    // 流内事件不带响应头；网关若在 body 里写 retry-after 由文案兜底解析。
    serverRetryHint: undefined,
    // 事件不是 JS 异常实例，按规则天然只会是 http / network。
    origin: resolveOrigin(undefined, status, message),
    arrival: "stream_event",
    fingerprint: computeFingerprint(status, upstreamType, message),
  };
  const retryAfter = parseRetryAfter(raw);
  if (retryAfter) n.retryAfterMs = retryAfter;
  return n;
}

// ─── 唯一分类器 ───

/** 错误族：只用来查预算与退避节奏（recovery-policy.ts），不决定生死。 */
export type ErrorFamily = "transient" | "auth_suspect" | "request_suspect" | "local_fault";

export type FamilyReason =
  | RetryableReason
  | SuspectReason
  | StreamValidationReason
  | "local_fault"
  | "unrecognized";

export interface FamilyVerdict {
  family: ErrorFamily;
  /** 细分原因（进遥测、驱动退避的限流抖动、S4 白名单、S5 配额发还） */
  reason: FamilyReason;
  /**
   * 是否「认出来了」。`false` = 落进 transient 只是因为认不出（未识别子集），
   * 只有这一子集受「同一指纹连续 3 次即放弃」约束，并写 `UnrecognizedError` 台账。
   */
  recognized: boolean;
  /**
   * 文案命中「真 key 作废」白名单（`invalid x-api-key` 等）。⛔ 只能**缩短退避间隔**，
   * 不能把次数降到下限以下——措辞白名单只能加速，不能判死。
   */
  realAuthFailure?: boolean;
}

/** 「真 key 作废」措辞（小写）：只用来缩短 auth_suspect 的退避间隔。 */
const REAL_AUTH_FAILURE_MESSAGES = [
  "invalid api key",
  "invalid x-api-key",
  "authentication_error",
  "authentication error",
  "authentication failed",
  "x-api-key header is required",
  "no auth credentials",
  "credentials expired",
  "organization has been disabled",
];

const REQUEST_SUSPECT_LEXICON: ReadonlySet<string> = new Set([
  "model_not_found",
  "quota_exhausted",
  "content_policy",
  "invalid_request",
  "usage_limit_reached",
]);

function byStatus(status: number): FamilyVerdict {
  switch (status) {
    case 401:
    case 403:
      return { family: "auth_suspect", reason: "auth_failed", recognized: true };
    case 402:
      return { family: "request_suspect", reason: "quota_exhausted", recognized: true };
    case 404:
      return { family: "request_suspect", reason: "model_not_found", recognized: true };
    case 400:
    case 422:
    // 413：上下文溢出那部分已在决策第 0 步经 `isPromptTooLong` 转交；走到这里的是单个附件
    // 过大（图片 / PDF），压缩历史治不了，按请求可疑处理（设计 §8 B 组反例）。
    case 413:
      return { family: "request_suspect", reason: "invalid_request", recognized: true };
    case 408:
      return { family: "transient", reason: "request_timeout", recognized: true };
    case 409:
      return { family: "transient", reason: "lock_timeout", recognized: true };
    case 429:
      return { family: "transient", reason: "rate_limit", recognized: true };
    case 503:
    case 529:
      return { family: "transient", reason: "overloaded", recognized: true };
    case 500:
    case 502:
    case 504:
      return { family: "transient", reason: "server_error", recognized: true };
    default:
      // 不在表里的状态码（418 / 499 / 520 / 522 / 530 …）：**不**回退文案（文本里的巧合
      // 关键词不该推翻一个结构化状态码），按认不出进 transient。
      return {
        family: "transient",
        reason: status >= 500 ? "server_error" : "unrecognized",
        recognized: false,
      };
  }
}

/** 上游结构化 type（anthropic error.type / openai code）。比状态码更具体，先看它。 */
function byUpstreamType(type: string): FamilyVerdict | undefined {
  const t = type.toLowerCase();
  if (t.includes("overloaded"))
    return { family: "transient", reason: "overloaded", recognized: true };
  if (t.includes("rate_limit"))
    return { family: "transient", reason: "rate_limit", recognized: true };
  if (t.includes("authentication") || t.includes("permission")) {
    return { family: "auth_suspect", reason: "auth_failed", recognized: true };
  }
  if (t.includes("not_found"))
    return { family: "request_suspect", reason: "model_not_found", recognized: true };
  if (t.includes("invalid_request")) {
    return { family: "request_suspect", reason: "invalid_request", recognized: true };
  }
  return undefined;
}

/**
 * 唯一分类器。判据只读 `status` / `upstreamType` / `serverRetryHint` / `origin` / `message`
 * （以及本地明确给出的 `presetReason` / `validation`），⛔ 不读 `arrival`。
 *
 * 顺序：本地 bug → 本地已知事实（预置原因 / 校验失败）→ 上游结构化 type → 状态码 →
 * `x-should-retry: true` → 共享词表 → 网络码/连接文案 → 认不出（transient 未识别）。
 * `x-should-retry: false` 不在这里处理：它是 I1-例外，由决策函数第 0 步直接放弃。
 */
export function classifyFamily(err: NormalizedLLMError): FamilyVerdict {
  const lower = err.message.toLowerCase();
  const realAuthFailure = REAL_AUTH_FAILURE_MESSAGES.some((m) => lower.includes(m)) || undefined;
  const withAuthHint = (v: FamilyVerdict): FamilyVerdict =>
    v.family === "auth_suspect" && realAuthFailure ? { ...v, realAuthFailure } : v;

  if (err.origin === "local")
    return { family: "local_fault", reason: "local_fault", recognized: true };
  if (err.presetReason) return { family: "transient", reason: err.presetReason, recognized: true };
  if (err.validation) return { family: "transient", reason: err.validation, recognized: true };

  if (err.upstreamType) {
    const v = byUpstreamType(err.upstreamType);
    if (v) return withAuthHint(v);
  }
  if (err.status !== undefined) return withAuthHint(byStatus(err.status));
  if (err.serverRetryHint === true)
    return { family: "transient", reason: "server_error", recognized: true };

  const code = matchErrorLexicon(err.message);
  if (code && isClassifierLexiconCode(code)) {
    if (code === "auth_failed")
      return withAuthHint({ family: "auth_suspect", reason: code, recognized: true });
    if (REQUEST_SUSPECT_LEXICON.has(code)) {
      return { family: "request_suspect", reason: code as SuspectReason, recognized: true };
    }
    return { family: "transient", reason: code as RetryableReason, recognized: true };
  }
  if (isNetworkFailure(err.raw) || isNetworkFailure(err.message)) {
    return { family: "transient", reason: "network_error", recognized: true };
  }
  return { family: "transient", reason: "unrecognized", recognized: false };
}
