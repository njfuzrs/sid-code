/**
 * 插件 memoize 缓存注册中心
 *
 * 各个 memoized 插件加载函数（loader / loadPluginCommands / ...）在模块加载时
 * 将自己的 .clear 注册进来，clearAllPluginCaches() 一次性清除全部。
 *
 * 用注册表模式而非在 memoize.ts 里硬编码引用，避免 utils → plugin 的循环依赖。
 */

const clearFns = new Set<() => void>();

/** 注册一个缓存清除函数（幂等，重复注册同一引用无副作用） */
export function registerPluginCache(clear: () => void): void {
  clearFns.add(clear);
}

/** 清除所有已注册的插件 memoize 缓存 */
export function clearAllPluginCaches(): void {
  for (const clear of clearFns) {
    clear();
  }
}
