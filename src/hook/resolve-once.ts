/**
 * 原子竞争守卫（对齐 Claude Code 的 claimed + delivered 双标志语义）
 *
 * 多路并发权限决策中，确保只有一个路径能成功 resolve。
 * - claim(): 抢占锁——多个路径竞争时只有第一个 claim 成功
 * - resolve(): 投递值——必须先 claim 才能 resolve，且只能投递一次(delivered 防重)
 * - isResolved(): 返回是否已投递(而非是否已 claim)
 */

export interface ResolveOnce<T> {
  resolve: (value: T) => void;
  isResolved: () => boolean;
  claim: () => boolean;
}

export function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let claimed = false;
  let delivered = false;

  return {
    resolve(value: T) {
      if (!claimed) return;   // 未 claim 不能 resolve
      if (delivered) return;  // 防止重复投递
      delivered = true;
      resolve(value);
    },
    isResolved() {
      return delivered;       // 语义：值是否已投递（而非锁是否已占）
    },
    claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
  };
}
