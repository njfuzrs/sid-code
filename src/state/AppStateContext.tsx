/**
 * AppState React 集成层
 * 通过 useSyncExternalStore 实现精确订阅，只在选中切片变化时重渲染
 */

import React, { createContext, useContext } from "react";
import { useSyncExternalStore } from "react";
import type { Store } from "./store.ts";
import type { AppState } from "./app-state.ts";

type AppStateStore = Store<AppState>;

const AppStoreContext = createContext<AppStateStore | null>(null);

function useAppStore(): AppStateStore {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error("useAppStore 必须在 AppStateProvider 内使用");
  return store;
}

/** 精确订阅 AppState 的某个切片，只在该切片变化时重渲染 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/** 只获取 setState，不订阅任何状态 */
export function useSetAppState() {
  return useAppStore().setState;
}

/** 获取整个 Store（用于传递给非 React 代码） */
export function useAppStateStore() {
  return useAppStore();
}

/** Provider：Store 只创建一次，引用永不变化 */
export function AppStateProvider({
  children,
  store,
}: {
  children: React.ReactNode;
  store: AppStateStore;
}) {
  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  );
}
