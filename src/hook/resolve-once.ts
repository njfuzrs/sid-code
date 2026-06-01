/**
 * 原子竞争守卫
 * 多路并发权限决策中，确保只有一个路径能成功 resolve
 */

export interface ResolveOnce<T> {
  resolve: (value: T) => void;
  isResolved: () => boolean;
  claim: () => boolean;
}

export function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let claimed = false;

  return {
    resolve(value: T) {
      if (!claimed) return;
      resolve(value);
    },
    isResolved() {
      return claimed;
    },
    claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
  };
}
