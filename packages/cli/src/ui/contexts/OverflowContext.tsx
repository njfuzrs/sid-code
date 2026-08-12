import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from "react";

export interface OverflowState {
  overflowingIds: ReadonlySet<string>;
}

export interface OverflowActions {
  addOverflowingId: (id: string) => void;
  removeOverflowingId: (id: string) => void;
  reset: () => void;
}

const OverflowStateContext = createContext<OverflowState | undefined>(undefined);

const OverflowActionsContext = createContext<OverflowActions | undefined>(undefined);

export const useOverflowState = (): OverflowState | undefined => useContext(OverflowStateContext);

export const useOverflowActions = (): OverflowActions | undefined =>
  useContext(OverflowActionsContext);

export const OverflowProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [overflowingIds, setOverflowingIds] = useState(new Set<string>());

  /**
   * 使用 ref 追踪当前溢出 ID 集合，使用 timeout 批量更新到下一个 tick。
   * 这防止了无限渲染循环（布局震荡）：显示溢出提示 → 布局变化 → 隐藏提示 → 恢复布局 → 再次显示提示。
   */
  const idsRef = useRef(new Set<string>());
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const syncState = useCallback(() => {
    if (timeoutRef.current) return;

    // 使用 microtask 批量更新，打破同步递归循环。
    // 这防止了布局变化期间的 "Maximum update depth exceeded" 错误。
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setOverflowingIds((prevIds) => {
        // 优化：仅在集合实际变化时更新状态
        if (
          prevIds.size === idsRef.current.size &&
          [...prevIds].every((id) => idsRef.current.has(id))
        ) {
          return prevIds;
        }
        return new Set(idsRef.current);
      });
    }, 0);
  }, []);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  const addOverflowingId = useCallback(
    (id: string) => {
      if (!idsRef.current.has(id)) {
        idsRef.current.add(id);
        syncState();
      }
    },
    [syncState],
  );

  const removeOverflowingId = useCallback(
    (id: string) => {
      if (idsRef.current.has(id)) {
        idsRef.current.delete(id);
        syncState();
      }
    },
    [syncState],
  );

  const reset = useCallback(() => {
    if (idsRef.current.size > 0) {
      idsRef.current.clear();
      syncState();
    }
  }, [syncState]);

  const stateValue = useMemo(
    () => ({
      overflowingIds,
    }),
    [overflowingIds],
  );

  const actionsValue = useMemo(
    () => ({
      addOverflowingId,
      removeOverflowingId,
      reset,
    }),
    [addOverflowingId, removeOverflowingId, reset],
  );

  return (
    <OverflowStateContext.Provider value={stateValue}>
      <OverflowActionsContext.Provider value={actionsValue}>
        {children}
      </OverflowActionsContext.Provider>
    </OverflowStateContext.Provider>
  );
};
