/**
 * memoizeWithTTL / memoizeWithTTLAsync — 带过期的写穿缓存
 * （对齐 Claude Code 的 memoizeWithTTL 模式）
 *
 * 核心语义「写穿（stale-while-revalidate）」：
 * - 冷启动（无缓存）：阻塞计算，写入缓存
 * - 未过期：直接返回缓存值
 * - 已过期但未在刷新中：立即返回旧值，后台异步刷新（不阻塞调用者）
 *
 * 两个并发安全设计：
 * - 身份守卫：后台刷新完成时检查 `cache.get(key) === cached`，
 *   防止 cache.clear() 后旧刷新结果覆盖新条目
 * - 并发去重（仅 async 版本）：inFlight Map 保证 N 个并发冷启动
 *   只执行一次昂贵操作（如 N 个并发凭证刷新 → 1 次）
 *
 * 适用场景：可能过期的值——API 凭证、远程配置、模型可用性查询。
 */

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  refreshing: boolean;
}

export interface MemoizedTTLFunction<Args extends unknown[], Result> {
  (...args: Args): Result;
  cache: {
    clear: () => void;
    delete: (key: string) => boolean;
    size: () => number;
  };
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function defaultKey(...args: unknown[]): string {
  return args.length === 0 ? "" : JSON.stringify(args);
}

/**
 * 同步写穿缓存。
 * 过期时返回旧值并在后台调用 fn 刷新（fn 同步执行，但用 queueMicrotask
 * 推迟以保持「不阻塞当前调用」的语义）。
 */
export function memoizeWithTTL<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
  cacheLifetimeMs: number = DEFAULT_TTL_MS,
  cacheKeyFn: (...args: Args) => string = defaultKey,
): MemoizedTTLFunction<Args, Result> {
  const cache = new Map<string, CacheEntry<Result>>();

  const memoized = ((...args: Args): Result => {
    const key = cacheKeyFn(...args);
    const now = Date.now();
    const cached = cache.get(key);

    // 冷启动
    if (!cached) {
      const value = fn(...args);
      cache.set(key, { value, timestamp: now, refreshing: false });
      return value;
    }

    const isStale = now - cached.timestamp >= cacheLifetimeMs;

    // 过期且未在刷新：返回旧值，后台刷新
    if (isStale && !cached.refreshing) {
      cached.refreshing = true;
      queueMicrotask(() => {
        try {
          const fresh = fn(...args);
          // 身份守卫：确保期间没有被 clear/delete 替换
          if (cache.get(key) === cached) {
            cache.set(key, { value: fresh, timestamp: Date.now(), refreshing: false });
          }
        } catch {
          // 刷新失败：清除 refreshing 标记，下次再试
          if (cache.get(key) === cached) {
            cached.refreshing = false;
          }
        }
      });
    }

    return cached.value;
  }) as MemoizedTTLFunction<Args, Result>;

  memoized.cache = {
    clear: () => cache.clear(),
    delete: (key: string) => cache.delete(key),
    size: () => cache.size,
  };

  return memoized;
}

/**
 * 异步写穿缓存 + 并发去重。
 * inFlight Map 保证同一 key 的并发冷启动 / 后台刷新只执行一次。
 */
export function memoizeWithTTLAsync<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = DEFAULT_TTL_MS,
  cacheKeyFn: (...args: Args) => string = defaultKey,
): MemoizedTTLFunction<Args, Promise<Result>> {
  const cache = new Map<string, CacheEntry<Result>>();
  const inFlight = new Map<string, Promise<Result>>();

  const refresh = (key: string, args: Args): Promise<Result> => {
    // 并发去重：已有同 key 的请求在飞，复用它
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = fn(...args)
      .then((value) => {
        cache.set(key, { value, timestamp: Date.now(), refreshing: false });
        inFlight.delete(key);
        return value;
      })
      .catch((err) => {
        // 自纠正：失败时清除 inFlight，让下次重新尝试
        inFlight.delete(key);
        const cached = cache.get(key);
        if (cached) cached.refreshing = false;
        throw err;
      });

    inFlight.set(key, promise);
    return promise;
  };

  const memoized = ((...args: Args): Promise<Result> => {
    const key = cacheKeyFn(...args);
    const now = Date.now();
    const cached = cache.get(key);

    // 冷启动：阻塞等待（去重）
    if (!cached) {
      return refresh(key, args);
    }

    const isStale = now - cached.timestamp >= cacheLifetimeMs;

    // 过期且未在刷新：返回旧值，后台刷新（不 await）
    if (isStale && !cached.refreshing) {
      cached.refreshing = true;
      void refresh(key, args).catch(() => {
        // 后台刷新失败已在 refresh 内部处理，这里吞掉避免 unhandled rejection
      });
    }

    return Promise.resolve(cached.value);
  }) as MemoizedTTLFunction<Args, Promise<Result>>;

  memoized.cache = {
    clear: () => {
      cache.clear();
      inFlight.clear();
    },
    delete: (key: string) => {
      inFlight.delete(key);
      return cache.delete(key);
    },
    size: () => cache.size,
  };

  return memoized;
}
