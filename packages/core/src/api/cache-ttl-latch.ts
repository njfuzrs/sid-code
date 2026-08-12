/**
 * TTL 资格锁定（Latch 模式）—— G5
 *
 * 设计原则：防止优化措施本身成为问题。
 * TTL 是为了省钱，但 TTL 的变化会破坏缓存反而花钱（对标 CC should1hCacheTTL：
 * 会话中途从"未超额"变"超额"会让 TTL 从 1h 降 5min，这个字段变化破坏缓存，~20K tokens 浪费）。
 * 因此在会话 bootstrap 时锁定决策，整个会话不变。
 *
 * sid-code 当前阶段：API Key 直连，Anthropic 服务端根据 plan 自动决定 TTL（5min/1h），
 * 客户端无法显式控制。本模块作为架构预留——未来 API 支持客户端指定 TTL 时立即启用 latch 保护。
 */

export type CacheTTL = "5min" | "1h";

/** 会话级锁定状态（进程生命周期内不变） */
let latchedTTL: CacheTTL | null = null;

/**
 * 在会话 bootstrap 时调用一次，锁定 TTL 资格。
 * 后续调用返回已锁定的值（不重新计算）。
 *
 * 1h TTL 资格条件（对标 CC should1hCacheTTL）：付费订阅用户 且 未处于超额状态。
 */
export function resolveCacheTTL(options?: { isPaidUser?: boolean; isOverage?: boolean }): CacheTTL {
  // Latch：一旦锁定，整个会话不变
  if (latchedTTL !== null) return latchedTTL;

  const eligible = (options?.isPaidUser ?? false) && !(options?.isOverage ?? false);
  latchedTTL = eligible ? "1h" : "5min";
  return latchedTTL;
}

/** 获取当前锁定的 TTL（未锁定时返回 null） */
export function getLatchedTTL(): CacheTTL | null {
  return latchedTTL;
}

/** 重置 latch（仅用于新会话/测试） */
export function resetTTLLatch(): void {
  latchedTTL = null;
}

/**
 * 将 TTL 映射为 cache_control 参数。
 *
 * 当前 Anthropic API 只有 ephemeral（服务端根据用户身份决定 5min/1h），
 * 客户端无法显式指定 TTL。未来 API 支持显式 TTL（如 `{ type: "ephemeral", ttl: "1h" }`）时，
 * 在此处统一扩展。集中此一处转换，避免 TTL 语义散落各调用点。
 */
export function ttlToCacheControl(_ttl: CacheTTL): { type: "ephemeral" } {
  return { type: "ephemeral" };
}
