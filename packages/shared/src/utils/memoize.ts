/**
 * 异步函数 memoize 工具
 * 保证异步函数只执行一次，后续调用返回同一个 Promise
 * 用于 init() / 插件加载等需要单次执行保证的场景
 *
 * 增强（对标 Claude Code 的 memoize 模式）：
 * - 暴露 .cache（单 slot Map），支持外部预热（如 loadAllPlugins 完成后预热 cacheOnly）
 * - 暴露 .clear()，支持 /reload-plugins 清缓存
 * - 支持带参数的函数（参数不参与缓存键，单 slot 缓存——适用于进程级单例）
 */

/** memoize 包装后的函数类型 */
export type Memoized<Args extends unknown[], T> = ((...args: Args) => Promise<T>) & {
  /** 单 slot 缓存（key 恒为 undefined），供外部预热/读取 */
  cache: Map<undefined, Promise<T>>;
  /** 清除缓存 */
  clear: () => void;
};

export function memoize<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
): Memoized<Args, T> {
  const cache = new Map<undefined, Promise<T>>();

  const memoized = ((...args: Args) => {
    const cached = cache.get(undefined);
    if (cached) return cached;
    const promise = fn(...args);
    cache.set(undefined, promise);
    return promise;
  }) as Memoized<Args, T>;

  memoized.cache = cache;
  memoized.clear = () => cache.clear();

  return memoized;
}
