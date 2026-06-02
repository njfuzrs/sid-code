/**
 * lazySchema — 延迟构造 Zod Schema
 *
 * 解决两个问题：
 * 1. Schema 之间的循环引用（A 引用 B、B 引用 A 时直接构造会死循环）
 * 2. 启动性能（未使用的 Schema 不会被构造）
 *
 * 对齐 Claude Code 的 lazySchema() 设计：所有 SDK Schema 用工厂函数包装，
 * 首次调用时构造并缓存，后续调用返回缓存实例。
 */

import type { z } from "zod";

export function lazySchema<T extends z.ZodTypeAny>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => {
    if (!cached) {
      cached = factory();
    }
    return cached;
  };
}
