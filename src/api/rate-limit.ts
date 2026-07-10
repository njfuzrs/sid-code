/**
 * 速率限制状态管理
 *
 * 职责（对标 Claude Code）：
 * - 从 API 响应 HTTP headers 实时提取速率限制信息（Anthropic 的 anthropic-ratelimit-*）
 * - 计算利用率，给出 ok / warning / exceeded 状态，支持提前预警
 *
 * 与 llm/quota.ts 的关系：quota.ts 基于本地滑动窗口估算（无服务端真值），
 * 本模块从服务端 headers 拿真实剩余配额，两者互补。
 */

/** 速率限制状态 */
export interface RateLimitStatus {
  /** 当前状态 */
  status: "ok" | "warning" | "exceeded";
  /** 剩余请求数 */
  remainingRequests?: number;
  /** 剩余 token 数 */
  remainingTokens?: number;
  /** 重置时间（Unix 毫秒时间戳） */
  resetsAt?: number;
  /** 利用率（0-1） */
  utilization?: number;
  /** Retry-After 秒数 */
  retryAfterSeconds?: number;
}

/** warning 阈值（利用率） */
const WARNING_THRESHOLD = 0.8;

type HeaderSource = Headers | Record<string, string>;

function makeGetter(headers: HeaderSource): (key: string) => string | null {
  if (typeof (headers as Headers).get === "function") {
    return (key: string) => (headers as Headers).get(key);
  }
  const record = headers as Record<string, string>;
  // headers 可能大小写不一，做一次小写归一
  const lowerMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) lowerMap[k.toLowerCase()] = v;
  return (key: string) => lowerMap[key.toLowerCase()] ?? null;
}

function parseIntOrNaN(v: string | null): number {
  return parseInt(v ?? "", 10);
}

/**
 * 从 API 响应 headers 中提取速率限制信息。
 *
 * 兼容两族 header 命名（G8：OpenAI 系此前完全不提取，跑 OpenAI-wire provider 时
 * 限流状态永远显示 ok，用户在网关限流时处于盲区）：
 *
 * Anthropic API headers:
 *   anthropic-ratelimit-requests-limit / -remaining / -reset
 *   anthropic-ratelimit-tokens-limit / -remaining / -reset
 *   retry-after
 *
 * OpenAI（及兼容网关）headers:
 *   x-ratelimit-limit-requests / x-ratelimit-remaining-requests / x-ratelimit-reset-requests
 *   x-ratelimit-limit-tokens / x-ratelimit-remaining-tokens / x-ratelimit-reset-tokens
 *   （部分网关用 x-ratelimit-*-requests 与 x-ratelimit-requests-* 两种词序，均兼容）
 *   retry-after
 *
 * 同一响应两族 header 不会共存；取两族中"有值"的一族。reset 词序差异见 firstNumber。
 */
export function extractRateLimitFromHeaders(headers: HeaderSource): RateLimitStatus {
  const get = makeGetter(headers);

  // 两族 header 择一读取：优先 Anthropic 命名，缺失则回退 OpenAI 命名。
  const firstNumber = (...keys: string[]): number => {
    for (const k of keys) {
      const n = parseIntOrNaN(get(k));
      if (!isNaN(n)) return n;
    }
    return NaN;
  };
  const firstString = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = get(k);
      if (v) return v;
    }
    return null;
  };

  const requestsRemaining = firstNumber(
    "anthropic-ratelimit-requests-remaining",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-requests-remaining",
  );
  const tokensRemaining = firstNumber(
    "anthropic-ratelimit-tokens-remaining",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-tokens-remaining",
  );
  const requestsLimit = firstNumber(
    "anthropic-ratelimit-requests-limit",
    "x-ratelimit-limit-requests",
    "x-ratelimit-requests-limit",
  );
  const tokensLimit = firstNumber(
    "anthropic-ratelimit-tokens-limit",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-tokens-limit",
  );
  const resetStr = firstString(
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-requests-reset",
    "x-ratelimit-tokens-reset",
  );
  const retryAfter = parseIntOrNaN(get("retry-after"));

  // 利用率（取请求和 token 中较高的）
  let utilization = 0;
  if (!isNaN(requestsLimit) && requestsLimit > 0 && !isNaN(requestsRemaining)) {
    utilization = Math.max(utilization, 1 - requestsRemaining / requestsLimit);
  }
  if (!isNaN(tokensLimit) && tokensLimit > 0 && !isNaN(tokensRemaining)) {
    utilization = Math.max(utilization, 1 - tokensRemaining / tokensLimit);
  }

  let status: RateLimitStatus["status"] = "ok";
  if (utilization >= 1.0) status = "exceeded";
  else if (utilization >= WARNING_THRESHOLD) status = "warning";

  let resetsAt: number | undefined;
  if (resetStr) {
    const asNum = Number(resetStr);
    // reset 可能是 Unix 秒数，也可能是 ISO 时间串
    if (!isNaN(asNum) && asNum > 0) {
      resetsAt = asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      const parsed = new Date(resetStr).getTime();
      if (!isNaN(parsed)) resetsAt = parsed;
    }
  }

  return {
    status,
    remainingRequests: isNaN(requestsRemaining) ? undefined : requestsRemaining,
    remainingTokens: isNaN(tokensRemaining) ? undefined : tokensRemaining,
    resetsAt,
    utilization: utilization > 0 ? utilization : undefined,
    retryAfterSeconds: isNaN(retryAfter) ? undefined : retryAfter,
  };
}

/** 全局速率限制状态（每次 API 响应后更新） */
let currentStatus: RateLimitStatus = { status: "ok" };

export function updateRateLimitStatus(headers: HeaderSource): RateLimitStatus {
  currentStatus = extractRateLimitFromHeaders(headers);
  return currentStatus;
}

export function getCurrentRateLimitStatus(): RateLimitStatus {
  return currentStatus;
}

export function resetRateLimitStatus(): void {
  currentStatus = { status: "ok" };
}

/** 格式化速率限制状态为可读提示（warning/exceeded 时使用） */
export function formatRateLimitWarning(status: RateLimitStatus): string | null {
  if (status.status === "ok") return null;
  const parts: string[] = [];
  if (status.utilization !== undefined) {
    parts.push(`配额利用率 ${(status.utilization * 100).toFixed(0)}%`);
  }
  if (status.remainingTokens !== undefined) {
    parts.push(`剩余 ${status.remainingTokens} tokens`);
  }
  if (status.resetsAt) {
    const sec = Math.max(0, Math.round((status.resetsAt - Date.now()) / 1000));
    parts.push(`${sec}s 后重置`);
  }
  const prefix = status.status === "exceeded" ? "速率限制已超出" : "接近速率限制";
  return `${prefix}（${parts.join("，")}）`;
}
