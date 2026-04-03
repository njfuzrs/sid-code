/**
 * 异步函数 memoize 工具
 * 保证异步函数只执行一次，后续调用返回同一个 Promise
 * 用于 init() 等需要单次执行保证的场景
 */

export function memoize<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      promise = fn();
    }
    return promise;
  };
}
