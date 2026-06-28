/**
 * Beta Header 会话级锁定（sticky-on）—— G7
 *
 * 一旦在会话中使用了某个 beta header，整个会话期间都不移除。
 * 原因：anthropic-beta header 是 prompt cache key 的一部分，移除 = 缓存失效。
 *
 * 典型场景：会话中途动态切换 strict 模式会让 `token-efficient-tools` header 时有时无，
 * header 抖动直接废掉整段前缀缓存。sticky-on 保证只增不减，前缀稳定。
 *
 * 新会话 / `/clear` 时调用 resetBetaHeaders() 重置（不跨会话泄漏）。
 */

const activeBetaHeaders = new Set<string>();

/**
 * 注册一个 beta header（幂等）。一旦注册，整个会话生命周期内始终携带。
 */
export function stickyBetaHeader(header: string): void {
  activeBetaHeaders.add(header);
}

/**
 * 获取当前会话应携带的所有 beta headers。
 * 包含：本次需要的 + 历史上注册过的（sticky-on）。
 * 调用本函数即把 currentNeeded 注册为 sticky（后续即使条件关闭也仍携带）。
 */
export function getEffectiveBetaHeaders(currentNeeded: string[]): string[] {
  for (const h of currentNeeded) {
    if (h && h.trim()) activeBetaHeaders.add(h);
  }
  return [...activeBetaHeaders];
}

/** 重置（新会话/测试） */
export function resetBetaHeaders(): void {
  activeBetaHeaders.clear();
}
