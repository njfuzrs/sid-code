/**
 * lazySchema — 延迟构造 Zod Schema
 *
 * 解决两个问题：
 * 1. Schema 之间的循环引用（A 引用 B、B 引用 A 时直接构造会死循环）
 * 2. 启动性能（未使用的 Schema 不会被构造）
 *
 * 对齐 Claude Code 的 lazySchema() 设计：所有 SDK Schema 用工厂函数包装，
 * 首次调用时构造并缓存，后续调用返回缓存实例。
 *
 * 注意：泛型不绑定具体 zod 版本（v3 classic / v4 子路径）的 ZodType。
 * 本仓 sdk/ 模块用 v3 schema、工具层用 v4 schema（为了 z.toJSONSchema），
 * 二者的 ZodTypeAny 在 TS 层互不 assignable。lazySchema 仅缓存工厂返回值，
 * 与 schema 内部结构无关，故放宽为版本无关泛型，运行时行为不变。
 */

export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => {
    if (cached === undefined) {
      cached = factory();
    }
    return cached;
  };
}
