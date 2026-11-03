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

/**
 * 缓存判据用独立的 hasCached 标志，而不是 `cached === undefined`。
 *
 * 为什么不能用值本身判断：泛型 T 并未约束为非 undefined（`() => T` 里 T 可以是
 * `string | undefined`、`null` 等）。用「值是否为 undefined」当缓存判据，等于给
 * 公共 API 加了一个从未声明的前提——「调用方恰好不返回 undefined」。一旦某个工厂
 * 返回 undefined（或将来改成条件返回），缓存就永远不生效，每次调用都重新构造，
 * 而且完全静默：不会报错，只是退化成没有缓存（解循环引用仍安全，但启动性能的
 * 优化静默失效）。同理也不能用 `if (!cached)`，那会把 null / 0 / "" 一并当成未缓存。
 *
 * 这与仓库里 `explicit-undefined-punches-through-defaults` 是同一族问题：
 * 用「值等价于缺省」来隐式表达「有没有过」，而 undefined 本来就是合法的值。
 * 显式记录「是否已计算过」才能把两种语义分开。
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T;
  let hasCached = false;
  return () => {
    if (!hasCached) {
      cached = factory();
      hasCached = true;
    }
    return cached;
  };
}
