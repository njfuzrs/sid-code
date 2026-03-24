/**
 * useHistoryManager — 管理 HistoryItem[] 的 React Hook
 *
 * 参考 gemini-cli useHistoryManager.ts，适配 sid-code 的类型系统。
 *
 * 职责：
 * - 维护 HistoryItem[] 状态，自动分配递增 id
 * - 提供 addItem / updateItem / clearItems / rebuildFromMessages 接口
 * - 供 App.tsx 在 agent loop 回调中调用，替代手动拼接数组
 */

import { useState, useRef, useCallback, useMemo } from "react";
import type { HistoryItem, HistoryItemWithoutId } from "../types.ts";
import type { Message } from "../../llm/types.ts";
import { messagesToHistoryItems } from "../history-adapter.ts";

/** updater 函数类型 */
type HistoryItemUpdater = (prevItem: HistoryItem) => Partial<Omit<HistoryItem, "id">>;

export interface UseHistoryManagerReturn {
  /** 当前历史列表 */
  history: HistoryItem[];
  /** 添加一项，返回分配的 id */
  addItem: (itemData: HistoryItemWithoutId) => number;
  /** 批量添加 */
  addItems: (items: HistoryItemWithoutId[]) => number[];
  /** 更新指定 id 的项 */
  updateItem: (id: number, updates: Partial<Omit<HistoryItem, "id">> | HistoryItemUpdater) => void;
  /** 清空历史 */
  clearItems: () => void;
  /** 从 LLM Message[] 完整重建（/compact 后使用） */
  rebuildFromMessages: (msgs: Message[]) => void;
  /** 从 LLM Message[] 增量同步新消息 */
  syncFromMessages: (msgs: Message[], lastSyncedCount: number) => number;
}

export function useHistoryManager(): UseHistoryManagerReturn {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const idCounterRef = useRef(0);

  const nextId = useCallback((): number => {
    idCounterRef.current += 1;
    return idCounterRef.current;
  }, []);

  const assignId = useCallback((item: HistoryItemWithoutId): HistoryItem => {
    return { ...item, id: nextId() } as HistoryItem;
  }, [nextId]);

  const addItem = useCallback((itemData: HistoryItemWithoutId): number => {
    const newItem = assignId(itemData);
    setHistory(prev => [...prev, newItem]);
    return newItem.id;
  }, [assignId]);

  const addItems = useCallback((items: HistoryItemWithoutId[]): number[] => {
    if (items.length === 0) return [];
    const newItems = items.map(assignId);
    setHistory(prev => [...prev, ...newItems]);
    return newItems.map(i => i.id);
  }, [assignId]);

  const updateItem = useCallback((
    id: number,
    updates: Partial<Omit<HistoryItem, "id">> | HistoryItemUpdater,
  ) => {
    setHistory(prev => prev.map(item => {
      if (item.id !== id) return item;
      const newUpdates = typeof updates === "function" ? updates(item) : updates;
      return { ...item, ...newUpdates } as HistoryItem;
    }));
  }, []);

  const clearItems = useCallback(() => {
    setHistory([]);
    idCounterRef.current = 0;
  }, []);

  const rebuildFromMessages = useCallback((msgs: Message[]) => {
    idCounterRef.current = 0;
    const itemsWithoutId = messagesToHistoryItems(msgs);
    const items = itemsWithoutId.map(assignId);
    setHistory(items);
  }, [assignId]);

  const syncFromMessages = useCallback((msgs: Message[], lastSyncedCount: number): number => {
    const newCount = msgs.length - lastSyncedCount;
    if (newCount <= 0) return lastSyncedCount;

    const newMsgs = msgs.slice(lastSyncedCount);
    const newItemsWithoutId = messagesToHistoryItems(newMsgs);
    if (newItemsWithoutId.length > 0) {
      const newItems = newItemsWithoutId.map(assignId);
      setHistory(prev => [...prev, ...newItems]);
    }
    return msgs.length;
  }, [assignId]);

  return useMemo(() => ({
    history,
    addItem,
    addItems,
    updateItem,
    clearItems,
    rebuildFromMessages,
    syncFromMessages,
  }), [history, addItem, addItems, updateItem, clearItems, rebuildFromMessages, syncFromMessages]);
}
