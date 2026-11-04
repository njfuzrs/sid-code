/**
 * 上游 HTTP 错误体的结构化解析（2026-11-04 F2 ①）。
 *
 * ── 为什么要在 provider 层做 ──
 *
 * 分类器 `classifyFamily` 的第一道判据是 `byUpstreamType`（上游明确给出的结构化
 * type/code），但此前 provider 的 `!response.ok` 分支只把 message 与 statusCode
 * 放进 `error` 事件，正文里的 `type` / `code` 一个字都没解析出来 —— 于是第一道
 * 判据永远拿不到东西，直接落到 `byStatus(403)` 的「鉴权可疑」。
 *
 * 事故形态（会话 `20261103-213816-f5beebde`）：网关回
 * `403 {"error":{"message":"令牌[...]额度不足","type":"shell_api_error","code":"pre_consume_token_quota_failed"}}`，
 * 分类拿到的是 `auth_suspect`，主循环 + 3 个子代理各自白试 3 次。
 *
 * ── 为什么 `code` 优先于 `type` ──
 *
 * 网关族的 `type` 常是**泛化外壳**（`shell_api_error`），没有判别力；真正具体的
 * 原因在 `code`（`pre_consume_token_quota_failed` / `insufficient_quota` /
 * `rate_limit_exceeded`）。官方 API 则相反：OpenAI 的 `code` 常为 null、
 * Anthropic 根本没有 `code` 字段，此时 `type` 就是唯一的结构化信息。
 * 所以规则是「有 code 用 code，没有才用 type」，两个方向的真实形态都覆盖到。
 *
 * ⚠️ 这只是**解析**，不做分类。分类仍只有 `error-normalize.ts::classifyFamily`
 * 一处（本模块不依赖它，避免形成第二个分类器）。
 */

/** 上游错误体里对下游有用的三个结构化字段。 */
export interface UpstreamErrorBody {
  /** 上游 `error.type`（Anthropic 官方字段 / OpenAI 的 error type） */
  type?: string;
  /** 上游 `error.code`（OpenAI 的 error code / 网关扩展 code，判别力更强） */
  code?: string;
  /** 上游人类可读 message（拿不到为 undefined） */
  message?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * 取一个「可当作标签」的字符串：非空、非纯空白、不是字面量 `"error"`。
 *
 * `"error"` 要排除：它是 `{type:"error", error:{…}}` 里的**外层哨兵**，不是成因标签。
 * 这条口径与 `error-normalize.ts::pickTag` / `anthropic.ts` 的 `pickUpstreamTag`
 * 完全一致——同一个过滤规则在三处各写一遍迟早漂移，所以这里统一。
 */
function pickTag(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" && v !== "error" ? v : undefined;
}

function pickMessage(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * 解析上游错误响应体。
 *
 * 兼容的实际形态（都是本仓撞到过的）：
 * - `{"error":{"message":"…","type":"shell_api_error","code":"pre_consume_token_quota_failed"}}`（网关）
 * - `{"error":{"message":"…","type":"invalid_request_error","code":null}}`（OpenAI 官方）
 * - `{"type":"error","error":{"type":"overloaded_error","message":"…"}}`（Anthropic 官方）
 * - `{"error":"some plain string"}` / 非 JSON / 空 body → 返回 `{}`
 *
 * **永不抛错**：解析失败返回空对象，调用方按「没有结构化信息」处理。
 * 错误路径上再抛一个新错误，只会把原始根因盖掉。
 */
export function parseUpstreamErrorBody(raw: string): UpstreamErrorBody {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const root = asRecord(parsed);
  if (!root) return {};

  // 三层都看：`{error:{error:{…}}}`（SDK 包裹）/ `{error:{…}}` / 扁平 `{…}`。
  const errorObj = asRecord(root.error);
  const innerError = asRecord(errorObj?.error);

  const type = pickTag(innerError?.type) ?? pickTag(errorObj?.type) ?? pickTag(root.type);
  const code = pickTag(innerError?.code) ?? pickTag(errorObj?.code) ?? pickTag(root.code);
  const message =
    pickMessage(innerError?.message) ?? pickMessage(errorObj?.message) ?? pickMessage(root.message);

  const out: UpstreamErrorBody = {};
  if (type !== undefined) out.type = type;
  if (code !== undefined) out.code = code;
  if (message !== undefined) out.message = message;
  return out;
}

/**
 * 选出要传给下游的**判别标签**：`code` 优先于 `type`。
 *
 * 理由见文件头「为什么 code 优先于 type」。返回 undefined 表示上游没给任何
 * 可用的结构化字段，调用方不要自行编一个。
 */
export function pickUpstreamTag(body: UpstreamErrorBody): string | undefined {
  return body.code ?? body.type;
}
