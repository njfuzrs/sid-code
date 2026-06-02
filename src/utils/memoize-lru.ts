/**
 * memoizeWithLRU — 有界 LRU 缓存（对齐 Claude Code 的 memoizeWithLRU 模式）
 *
 * 解决「无界缓存导致内存泄漏」问题：长会话中热路径（token 估算、
 * 路径解析、Markdown 渲染）会产生大量不同的 key，简单 Map 缓存
 * 会无限增长。LRU 在达到 maxCacheSize 时驱逐最久未使用的条目。
 *
 * 实现：Map 的插入顺序即访问顺序（JS Map 保证插入序）。
 * - get 命中：delete + set 把条目移到末尾（最近使用）
 * - set 满：删除第一个 key（最久未使用）
 * 无需手写双向链表，借助 Map 有序性即可达到 O(1) 摊还。
 */

export interface LRUMemoizedFunction<Args extends unknown[], Result> {
  (...args: Args): Result;
  cache: {
    clear: () => void;
    size: () => number;
    delete: (key: string) => boolean;
    has: (key: string) => boolean;
  };
}

const DEFAULT_MAX_SIZE = 100;

/**
 * @param fn 被缓存的纯函数
 * @param cacheKeyFn 从参数生成缓存 key（必填，热路径通常有明确的 key）
 * @param maxCacheSize 最大缓存条目数，默认 100
 */
export function memoizeWithLRU<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
  cacheKeyFn: (...args: Args) => string,
  maxCacheSize: number = DEFAULT_MAX_SIZE,
): LRUMemoizedFunction<Args, Result> {
  const cap = Math.max(1, maxCacheSize);
  const cache = new Map<string, Result>();

  const memoized = ((...args: Args): Result => {
    const key = cacheKeyFn(...args);

    if (cache.has(key)) {
      // 命中：移到末尾标记为最近使用
      const value = cache.get(key) as Result;
      cache.delete(key);
      cache.set(key, value);
      return value;
    }

    // 未命中：计算并写入
    const value = fn(...args);
    cache.set(key, value);

    // 超容量：驱逐最久未使用（Map 的第一个 key）
    if (cache.size > cap) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }

    return value;
  }) as LRUMemoizedFunction<Args, Result>;

  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    has: (key: string) => cache.has(key),
  };

  return memoized;
}
