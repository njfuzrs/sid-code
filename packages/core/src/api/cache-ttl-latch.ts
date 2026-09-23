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
 *
 * ## ⚠️ 哪些导出在生产路径上（P3-23 实测核验，别凭函数名猜）
 *
 * **生产零调用**：`resolveCacheTTL` / `getLatchedTTL` / `ttlToCacheControl` —— 除本文件
 * 自身与测试外，全仓无任何调用点。latch 从未被写入过，`getLatchedTTL()` 在生产上恒为 `null`。
 *
 * **生产在用但当前是空转**：`resetTTLLatch`（`app.ts` 两处，会话/上下文重置时调）。
 * 它清的是一个**从没有人设置过**的 latch，因此恒为 no-op。保留它是对的 ——
 * 一旦上面三个函数接上生产路径，漏掉重置就会让新会话继承上一个会话的 TTL 决策
 * （正是本模块要防的那类「优化措施本身成为问题」）。
 *
 * 写明这段的理由（与 `cache-strategy.ts` 头部同一纪律）：本模块的注释原本只说「架构预留」，
 * 读起来像「已接好、等 API」。实际是**一个字节都没接**。这类「防线全在、调用全 0」的
 * 措辞差异，会让下一次审查把它当成已生效的省钱机制而算进 cache 口径 ——
 * 北极星自检第 2 问「每个指标必须能指到源字段」，指不到就不能当结论。
 *
 * **不删的理由**：TTL latch 是有事故背书的设计（会话中途 TTL 从 1h 降 5min 会破坏缓存，
 * ~20K token 浪费）。删掉等于把这份判断也删了，等 API 放开时要重新推一遍。
 * 保留 + 注释说清「零调用」，比删掉或假装已接都更便宜。
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
