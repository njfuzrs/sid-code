/**
 * 底层错误提取工具
 *
 * 职责（对标 Claude Code 的 errorUtils.ts）：
 * - 遍历错误的 cause 链，提取根因（网络错误码 / HTTP 状态 / SSL 详情）
 * - SSL/TLS 错误诊断（企业代理场景常见）
 *
 * 设计原则：纯函数、无副作用，可被 errors.ts / llm/fallback.ts 复用。
 */

/** cause 链遍历的最大深度（防御循环引用） */
const MAX_CAUSE_DEPTH = 10;

/** 常见 SSL 错误码及诊断建议 */
export const SSL_ERROR_HINTS: Record<string, string> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "企业代理？请设置 NODE_EXTRA_CA_CERTS 环境变量指向代理 CA 证书",
  CERT_HAS_EXPIRED: "证书已过期，请检查系统时间或代理证书",
  SELF_SIGNED_CERT_IN_CHAIN: "检测到自签名证书，请设置 NODE_EXTRA_CA_CERTS",
  DEPTH_ZERO_SELF_SIGNED_CERT: "自签名证书，请设置 NODE_EXTRA_CA_CERTS",
  ERR_TLS_CERT_ALTNAME_INVALID: "证书域名不匹配，请检查代理配置",
  CERT_SIGNATURE_FAILURE: "证书签名验证失败",
  CERT_NOT_YET_VALID: "证书尚未生效，请检查系统时间",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "无法本地验证签发证书，请设置 NODE_EXTRA_CA_CERTS",
};

/** 提取出的连接错误详情 */
export interface ConnectionErrorDetails {
  /** 网络/SSL 错误码（如 ECONNRESET、CERT_HAS_EXPIRED） */
  code?: string;
  /** 是否是 SSL/TLS 错误 */
  isSSLError: boolean;
}

/**
 * 遍历错误的 cause 链，提取首个带 code 的连接错误详情
 *
 * 多数运行时把底层 socket/TLS 错误包在 cause 链里（fetch → TypeError → cause: Error{code}），
 * 因此需要逐层下钻而不是只看顶层 error.code。
 */
export function extractConnectionErrorDetails(error: unknown): ConnectionErrorDetails | undefined {
  let current: any = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (current.code && typeof current.code === "string") {
      const code: string = current.code;
      return {
        code,
        isSSLError:
          code in SSL_ERROR_HINTS || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_"),
      };
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * 获取 SSL 错误的诊断建议。
 * 仅在确实是 SSL/TLS 错误时返回建议，否则返回 undefined。
 */
export function getSSLErrorHint(error: unknown): string | undefined {
  const details = extractConnectionErrorDetails(error);
  if (!details?.isSSLError || !details.code) return undefined;
  return SSL_ERROR_HINTS[details.code] ?? `SSL/TLS 错误 (${details.code})`;
}

/**
 * 从错误中提取 HTTP 状态码。
 * 兼容多种 SDK 形态：error.status / error.statusCode / error.response.status / 消息里的裸状态码。
 */
export function extractHTTPStatus(error: unknown): number | undefined {
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
 * 安全地获取错误消息字符串。
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 从错误中提取 HTTP response headers（用于速率限制提取）。
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
