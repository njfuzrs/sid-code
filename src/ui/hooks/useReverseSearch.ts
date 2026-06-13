/**
 * 反向搜索 Hook（Ctrl+R）
 *
 * 参考 gemini-cli useReverseSearchCompletion
 * 在输入历史中反向搜索匹配的条目。
 *
 * 使用方式：
 * 1. Ctrl+R 激活反向搜索模式
 * 2. 输入搜索关键词，实时过滤历史
 * 3. Enter 选中当前匹配项
 * 4. Ctrl+R 继续搜索下一个匹配
 * 5. Escape 退出搜索模式
 */

import { useState, useCallback } from "react";

export interface ReverseSearchState {
  /** 是否处于反向搜索模式 */
  active: boolean;
  /** 搜索关键词 */
  query: string;
  /** 当前匹配的历史条目 */
  match: string | null;
  /** 当前匹配的索引 */
  matchIndex: number;
}

export interface UseReverseSearchProps {
  /** 历史记录列表（最新在前） */
  history: string[];
}

export interface UseReverseSearchReturn {
  /** 搜索状态 */
  state: ReverseSearchState;
  /** 激活反向搜索 */
  activate: () => void;
  /** 退出反向搜索 */
  deactivate: () => void;
  /** 输入搜索字符 */
  appendQuery: (char: string) => void;
  /** 删除搜索字符 */
  deleteQuery: () => void;
  /** 搜索下一个匹配 */
  searchNext: () => void;
  /** 搜索上一个匹配（反方向遍历） */
  searchPrev: () => void;
  /** 获取当前匹配结果 */
  getMatch: () => string | null;
}

export function useReverseSearch({ history }: UseReverseSearchProps): UseReverseSearchReturn {
  const [state, setState] = useState<ReverseSearchState>({
    active: false,
    query: "",
    match: null,
    matchIndex: -1,
  });

  const findMatch = useCallback((query: string, startIndex: number): { match: string; index: number } | null => {
    if (!query) return null;
    const lowerQuery = query.toLowerCase();
    for (let i = startIndex; i < history.length; i++) {
      if (history[i].toLowerCase().includes(lowerQuery)) {
        return { match: history[i], index: i };
      }
    }
    return null;
  }, [history]);

  /** 向更早方向（索引减小）查找匹配 */
  const findMatchBackward = useCallback((query: string, startIndex: number): { match: string; index: number } | null => {
    if (!query) return null;
    const lowerQuery = query.toLowerCase();
    for (let i = startIndex; i >= 0; i--) {
      if (history[i] && history[i].toLowerCase().includes(lowerQuery)) {
        return { match: history[i], index: i };
      }
    }
    return null;
  }, [history]);

  const activate = useCallback(() => {
    setState({ active: true, query: "", match: null, matchIndex: -1 });
  }, []);

  const deactivate = useCallback(() => {
    setState({ active: false, query: "", match: null, matchIndex: -1 });
  }, []);

  const appendQuery = useCallback((char: string) => {
    setState(prev => {
      if (!prev.active) return prev;
      const newQuery = prev.query + char;
      const result = findMatch(newQuery, 0);
      return {
        ...prev,
        query: newQuery,
        match: result?.match ?? null,
        matchIndex: result?.index ?? -1,
      };
    });
  }, [findMatch]);

  const deleteQuery = useCallback(() => {
    setState(prev => {
      if (!prev.active || prev.query.length === 0) return prev;
      const newQuery = prev.query.slice(0, -1);
      if (!newQuery) {
        return { ...prev, query: "", match: null, matchIndex: -1 };
      }
      const result = findMatch(newQuery, 0);
      return {
        ...prev,
        query: newQuery,
        match: result?.match ?? null,
        matchIndex: result?.index ?? -1,
      };
    });
  }, [findMatch]);

  const searchNext = useCallback(() => {
    setState(prev => {
      if (!prev.active || !prev.query) return prev;
      const result = findMatch(prev.query, prev.matchIndex + 1);
      if (result) {
        return { ...prev, match: result.match, matchIndex: result.index };
      }
      // 循环到开头
      const fromStart = findMatch(prev.query, 0);
      if (fromStart) {
        return { ...prev, match: fromStart.match, matchIndex: fromStart.index };
      }
      return prev;
    });
  }, [findMatch]);

  /** 搜索上一个匹配（向更新方向，索引减小）。到头则循环到末尾。 */
  const searchPrev = useCallback(() => {
    setState(prev => {
      if (!prev.active || !prev.query) return prev;
      const result = findMatchBackward(prev.query, prev.matchIndex - 1);
      if (result) {
        return { ...prev, match: result.match, matchIndex: result.index };
      }
      // 循环到末尾
      const fromEnd = findMatchBackward(prev.query, history.length - 1);
      if (fromEnd) {
        return { ...prev, match: fromEnd.match, matchIndex: fromEnd.index };
      }
      return prev;
    });
  }, [findMatchBackward, history.length]);

  const getMatch = useCallback((): string | null => {
    return state.match;
  }, [state.match]);

  return { state, activate, deactivate, appendQuery, deleteQuery, searchNext, searchPrev, getMatch };
}
