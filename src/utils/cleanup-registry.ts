/**
 * 清理注册表（对齐 Claude Code 的 cleanupRegistry.ts）
 *
 * 零依赖模块：任何模块都可以安全导入而不引入循环依赖。
 * 与 graceful shutdown 逻辑分离，避免「清理注册」反向依赖「退出流程」。
 *
 * 用法：
 *   const unregister = registerCleanup(async () => { await client.close(); });
 *   // ... 资源释放后主动注销，避免重复执行
 *   unregister();
 *
 * 退出流程在合适的阶段调用 runCleanupFunctions() 并行执行全部清理。
 */

/** 已注册的清理函数集合 */
const cleanupFunctions = new Set<() => Promise<void>>();

/**
 * 注册清理函数，返回注销函数。
 * 同一个函数引用只会注册一次（Set 去重）。
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn);
  return () => {
    cleanupFunctions.delete(cleanupFn);
  };
}

/**
 * 并行执行所有已注册的清理函数。
 * 单个清理失败不影响其他清理（allSettled 语义），但会把失败原因收集后返回。
 *
 * @returns 执行过程中抛出的错误列表（空数组表示全部成功）
 */
export async function runCleanupFunctions(): Promise<unknown[]> {
  const fns = Array.from(cleanupFunctions);
  const results = await Promise.allSettled(fns.map((fn) => fn()));
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
}

/** 当前已注册的清理函数数量（测试 / 诊断用） */
export function cleanupCount(): number {
  return cleanupFunctions.size;
}

/** 清空所有注册（仅测试用，生产代码不应调用） */
export function clearCleanupRegistry(): void {
  cleanupFunctions.clear();
}
