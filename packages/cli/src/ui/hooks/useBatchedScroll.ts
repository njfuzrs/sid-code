/**
 * 批量滚动状态管理 hook
 *
 * 允许同一 tick 内多次滚动操作累积，通过 pending 状态在渲染后重置。
 * 参考 gemini-cli/packages/cli/src/ui/hooks/useBatchedScroll.ts
 */

import { useRef, useEffect, useCallback } from "react";

export function useBatchedScroll(currentScrollTop: number) {
  const pendingScrollTopRef = useRef<number | null>(null);
  const currentScrollTopRef = useRef(currentScrollTop);

  useEffect(() => {
    currentScrollTopRef.current = currentScrollTop;
    pendingScrollTopRef.current = null;
  });

  const getScrollTop = useCallback(
    () => pendingScrollTopRef.current ?? currentScrollTopRef.current,
    [],
  );

  const setPendingScrollTop = useCallback((newScrollTop: number) => {
    pendingScrollTopRef.current = newScrollTop;
  }, []);

  return { getScrollTop, setPendingScrollTop };
}
