/**
 * 并发 AsyncGenerator 工具（对齐 Claude Code 的 generators.ts）
 *
 * all()：基于 Promise.race 的流式并发控制器。
 * - 不是 Promise.all：边完成边 yield，调用者可流式处理结果
 * - 支持并发上限：默认 Infinity，可限制同时运行的 generator 数量
 * - 背压：达到上限时不再启动新 generator，等到有 slot 空出
 *
 * 适用场景：并发执行多个工具、并发拉取多个数据源，且希望
 * 「谁先完成先处理谁」而不是等全部完成。
 */

/** 收集 AsyncGenerator 的所有 yield 值到数组 */
export async function toArray<A>(gen: AsyncGenerator<A, void>): Promise<A[]> {
  const out: A[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

/**
 * 并发消费多个 AsyncGenerator，边完成边 yield。
 *
 * 实现要点：
 * - 为每个活跃的 generator 维护一个「下一步」Promise，包装上其来源索引
 * - Promise.race 选出最先 ready 的 generator，yield 其值后再排上它的下一步
 * - generator 耗尽（done）时从活跃集合移除，并在有上限时补充新的 generator
 *
 * @param generators 待并发消费的 generator 列表
 * @param concurrencyCap 并发上限，默认 Infinity（全部同时启动）
 */
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap: number = Infinity,
): AsyncGenerator<A, void> {
  const cap = Math.max(1, concurrencyCap);
  const queue = [...generators];

  // 活跃 generator → 它的「下一步」Promise（携带来源 key，便于 race 后定位）
  type Pending = Promise<{ key: number; res: IteratorResult<A, void> }>;
  const active = new Map<number, { gen: AsyncGenerator<A, void>; pending: Pending }>();
  let nextKey = 0;

  const startNext = () => {
    const gen = queue.shift();
    if (!gen) return;
    const key = nextKey++;
    const pending = gen.next().then((res) => ({ key, res }));
    active.set(key, { gen, pending });
  };

  // 初始填充到并发上限
  while (active.size < cap && queue.length > 0) {
    startNext();
  }

  while (active.size > 0) {
    const { key, res } = await Promise.race(
      Array.from(active.values(), (e) => e.pending),
    );

    const entry = active.get(key);
    if (!entry) continue;

    if (res.done) {
      // 该 generator 耗尽：移除，补充一个新的（背压控制）
      active.delete(key);
      if (queue.length > 0 && active.size < cap) {
        startNext();
      }
    } else {
      // yield 值，并为该 generator 排上下一步
      yield res.value;
      entry.pending = entry.gen.next().then((r) => ({ key, res: r }));
    }
  }
}
