/**
 * 会话浏览器 TUI 组件
 * 提供交互式会话选择、搜索、删除功能
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import type { Config } from "../config/config.ts";
import type { SessionInfo } from "./utils.ts";
import {
  getSessionFiles,
  formatRelativeTime,
  filterSessions,
  sortSessions,
} from "./utils.ts";
import { join } from "path";
import { homedir } from "os";
import { unlinkSync, existsSync } from "fs";

/** 每页显示的会话数 */
const SESSIONS_PER_PAGE = 20;

/** 固定列宽度（索引 + 消息数 + 时间 + 分隔符） */
const FIXED_COLUMNS_WIDTH = 30;

/** 会话浏览器属性 */
export interface SessionBrowserProps {
  config: Config;
  currentSessionId?: string;
  onResumeSession: (session: SessionInfo) => void;
  onDeleteSession: (session: SessionInfo) => Promise<void>;
  onExit: () => void;
}

/** 会话浏览器状态 */
export interface SessionBrowserState {
  // 数据状态
  sessions: SessionInfo[];
  filteredAndSortedSessions: SessionInfo[];

  // UI 状态
  loading: boolean;
  error: string | null;
  activeIndex: number;
  scrollOffset: number;

  // 搜索状态
  searchQuery: string;
  isSearchMode: boolean;
  hasLoadedFullContent: boolean;

  // 排序状态
  sortOrder: "date" | "messages" | "name";
  sortReverse: boolean;

  // 计算值
  totalSessions: number;
  startIndex: number;
  endIndex: number;
  visibleSessions: SessionInfo[];

  // 状态更新函数
  setSessions: React.Dispatch<React.SetStateAction<SessionInfo[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setIsSearchMode: React.Dispatch<React.SetStateAction<boolean>>;
  setSortOrder: React.Dispatch<React.SetStateAction<"date" | "messages" | "name">>;
  setSortReverse: React.Dispatch<React.SetStateAction<boolean>>;
  setHasLoadedFullContent: React.Dispatch<React.SetStateAction<boolean>>;
}

/** 状态管理 Hook */
function useSessionBrowserState(
  initialSessions: SessionInfo[] = [],
  initialLoading = true,
  initialError: string | null = null
): SessionBrowserState {
  const [sessions, setSessions] = useState<SessionInfo[]>(initialSessions);
  const [loading, setLoading] = useState(initialLoading);
  const [error, setError] = useState<string | null>(initialError);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [sortOrder, setSortOrder] = useState<"date" | "messages" | "name">("date");
  const [sortReverse, setSortReverse] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [hasLoadedFullContent, setHasLoadedFullContent] = useState(false);

  const filteredAndSortedSessions = useMemo(() => {
    const filtered = filterSessions(sessions, searchQuery);
    return sortSessions(filtered, sortOrder, sortReverse);
  }, [sessions, searchQuery, sortOrder, sortReverse]);

  // 搜索清空时重置完整内容标志
  useEffect(() => {
    if (!searchQuery) {
      setHasLoadedFullContent(false);
    }
  }, [searchQuery]);

  const totalSessions = filteredAndSortedSessions.length;
  const startIndex = scrollOffset;
  const endIndex = Math.min(scrollOffset + SESSIONS_PER_PAGE, totalSessions);
  const visibleSessions = filteredAndSortedSessions.slice(startIndex, endIndex);

  return {
    sessions,
    setSessions,
    loading,
    setLoading,
    error,
    setError,
    activeIndex,
    setActiveIndex,
    scrollOffset,
    setScrollOffset,
    searchQuery,
    setSearchQuery,
    isSearchMode,
    setIsSearchMode,
    hasLoadedFullContent,
    setHasLoadedFullContent,
    sortOrder,
    setSortOrder,
    sortReverse,
    setSortReverse,
    filteredAndSortedSessions,
    totalSessions,
    startIndex,
    endIndex,
    visibleSessions,
  };
}

/** 加载会话 Hook */
function useLoadSessions(
  config: Config,
  currentSessionId: string | undefined,
  state: SessionBrowserState
) {
  const {
    setSessions,
    setLoading,
    setError,
    isSearchMode,
    hasLoadedFullContent,
    setHasLoadedFullContent,
  } = state;

  useEffect(() => {
    const loadSessions = async () => {
      try {
        const home = process.env.HOME || homedir();
        const sessionDir = join(home, ".sid-code", "sessions");
        const sessionData = await getSessionFiles(sessionDir, currentSessionId);
        setSessions(sessionData);
        setLoading(false);
      } catch (err: any) {
        setError(err.message || "加载会话失败");
        setLoading(false);
      }
    };

    loadSessions();
  }, [config, currentSessionId, setSessions, setLoading, setError]);

  // 进入搜索模式时加载完整内容
  useEffect(() => {
    const loadFullContent = async () => {
      if (isSearchMode && !hasLoadedFullContent) {
        try {
          const home = process.env.HOME || homedir();
          const sessionDir = join(home, ".sid-code", "sessions");
          const sessionData = await getSessionFiles(sessionDir, currentSessionId, {
            includeFullContent: true,
          });
          setSessions(sessionData);
          setHasLoadedFullContent(true);
        } catch (err: any) {
          setError(err.message || "加载完整内容失败");
        }
      }
    };

    loadFullContent();
  }, [
    isSearchMode,
    hasLoadedFullContent,
    currentSessionId,
    setSessions,
    setHasLoadedFullContent,
    setError,
  ]);
}

/** 移动选择 Hook */
function useMoveSelection(state: SessionBrowserState) {
  const {
    totalSessions,
    activeIndex,
    scrollOffset,
    setActiveIndex,
    setScrollOffset,
  } = state;

  return useCallback(
    (delta: number) => {
      const newIndex = Math.max(
        0,
        Math.min(totalSessions - 1, activeIndex + delta)
      );
      setActiveIndex(newIndex);

      // 调整滚动偏移
      if (newIndex < scrollOffset) {
        setScrollOffset(newIndex);
      } else if (newIndex >= scrollOffset + SESSIONS_PER_PAGE) {
        setScrollOffset(newIndex - SESSIONS_PER_PAGE + 1);
      }
    },
    [totalSessions, activeIndex, scrollOffset, setActiveIndex, setScrollOffset]
  );
}

/** 切换排序 Hook */
function useCycleSortOrder(state: SessionBrowserState) {
  const { sortOrder, setSortOrder } = state;

  return useCallback(() => {
    const orders: Array<"date" | "messages" | "name"> = ["date", "messages", "name"];
    const currentIndex = orders.indexOf(sortOrder);
    const nextIndex = (currentIndex + 1) % orders.length;
    setSortOrder(orders[nextIndex]);
  }, [sortOrder, setSortOrder]);
}

/** 输入处理 Hook */
function useSessionBrowserInput(
  state: SessionBrowserState,
  moveSelection: (delta: number) => void,
  cycleSortOrder: () => void,
  onResumeSession: (session: SessionInfo) => void,
  onDeleteSession: (session: SessionInfo) => Promise<void>,
  onExit: () => void
) {
  useInput((input, key) => {
    if (state.isSearchMode) {
      // 搜索模式
      if (key.escape) {
        state.setIsSearchMode(false);
        state.setSearchQuery("");
        state.setActiveIndex(0);
        state.setScrollOffset(0);
      } else if (key.backspace || key.delete) {
        state.setSearchQuery((prev) => prev.slice(0, -1));
        state.setActiveIndex(0);
        state.setScrollOffset(0);
      } else if (input && !key.ctrl && !key.meta) {
        state.setSearchQuery((prev) => prev + input);
        state.setActiveIndex(0);
        state.setScrollOffset(0);
      }
    } else {
      // 导航模式
      if (input === "g") {
        state.setActiveIndex(0);
        state.setScrollOffset(0);
      } else if (input === "G") {
        state.setActiveIndex(state.totalSessions - 1);
        state.setScrollOffset(Math.max(0, state.totalSessions - SESSIONS_PER_PAGE));
      } else if (input === "s") {
        cycleSortOrder();
      } else if (input === "r") {
        state.setSortReverse(!state.sortReverse);
      } else if (input === "/") {
        state.setIsSearchMode(true);
      } else if (input === "q" || input === "Q" || key.escape) {
        onExit();
      } else if (input === "x" || input === "X") {
        const selectedSession = state.filteredAndSortedSessions[state.activeIndex];
        if (selectedSession && !selectedSession.isCurrentSession) {
          onDeleteSession(selectedSession)
            .then(() => {
              state.setSessions(
                state.sessions.filter((s) => s.id !== selectedSession.id)
              );
              if (state.activeIndex >= state.filteredAndSortedSessions.length - 1) {
                state.setActiveIndex(
                  Math.max(0, state.filteredAndSortedSessions.length - 2)
                );
              }
            })
            .catch((error: any) => {
              state.setError(`删除会话失败: ${error.message || "未知错误"}`);
            });
        }
      } else if (input === "u") {
        moveSelection(-Math.round(SESSIONS_PER_PAGE / 2));
      } else if (input === "d") {
        moveSelection(Math.round(SESSIONS_PER_PAGE / 2));
      }
    }

    // 通用按键
    if (key.return && state.filteredAndSortedSessions[state.activeIndex]) {
      const selectedSession = state.filteredAndSortedSessions[state.activeIndex];
      if (!selectedSession.isCurrentSession) {
        onResumeSession(selectedSession);
      }
    } else if (key.upArrow) {
      moveSelection(-1);
    } else if (key.downArrow) {
      moveSelection(1);
    } else if (key.pageUp) {
      moveSelection(-SESSIONS_PER_PAGE);
    } else if (key.pageDown) {
      moveSelection(SESSIONS_PER_PAGE);
    }
  });
}

/** 加载中组件 */
function SessionBrowserLoading(): JSX.Element {
  return (
    <Box flexDirection="column" padding={1}>
      <Text>加载会话中...</Text>
    </Box>
  );
}

/** 错误组件 */
function SessionBrowserError({ error }: { error: string }): JSX.Element {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">错误: {error}</Text>
      <Text dimColor>按 q 退出</Text>
    </Box>
  );
}

/** 空会话组件 */
function SessionBrowserEmpty(): JSX.Element {
  return (
    <Box flexDirection="column" padding={1}>
      <Text>未找到任何会话</Text>
      <Text dimColor>按 q 退出</Text>
    </Box>
  );
}

/** 导航帮助组件 */
function NavigationHelpDisplay(): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        ↑↓: 移动  Enter: 恢复  x: 删除  /: 搜索  s: 排序  r: 反转  q: 退出
      </Text>
    </Box>
  );
}

/** 搜索模式显示组件 */
function SearchModeDisplay({ query }: { query: string }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text>
        搜索: <Text color="cyan">{query}</Text>
        <Text dimColor>_</Text>
      </Text>
      <Text dimColor>Esc: 退出搜索</Text>
    </Box>
  );
}

/** 无结果显示组件 */
function NoResultsDisplay(): JSX.Element {
  return (
    <Box flexDirection="column" padding={1}>
      <Text>未找到匹配的会话</Text>
      <Text dimColor>按 Esc 清除搜索</Text>
    </Box>
  );
}

/** 列表头部组件 */
function SessionListHeader({ state }: { state: SessionBrowserState }): JSX.Element {
  const sortLabel = {
    date: "日期",
    messages: "消息数",
    name: "名称",
  }[state.sortOrder];

  return (
    <Box flexDirection="column">
      <Text>
        共 {state.totalSessions} 个会话 | 排序: {sortLabel}
        {state.sortReverse ? " (降序)" : " (升序)"}
      </Text>
    </Box>
  );
}

/** 表头组件 */
function SessionTableHeader({ state }: { state: SessionBrowserState }): JSX.Element {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text>{state.scrollOffset > 0 ? "▲ " : "  "}</Text>
      <Box width={5} flexShrink={0}>
        <Text color="gray" bold>
          索引
        </Text>
      </Box>
      <Text color="gray"> │ </Text>
      <Box width={4} flexShrink={0}>
        <Text color="gray" bold>
          消息
        </Text>
      </Box>
      <Text color="gray"> │ </Text>
      <Box width={4} flexShrink={0}>
        <Text color="gray" bold>
          时间
        </Text>
      </Box>
      <Text color="gray"> │ </Text>
      <Box flexShrink={0}>
        <Text color="gray" bold>
          {state.searchQuery ? "匹配" : "名称"}
        </Text>
      </Box>
    </Box>
  );
}

/** 匹配片段显示组件 */
function MatchSnippetDisplay({
  session,
  isActive,
}: {
  session: SessionInfo;
  isActive: boolean;
}): JSX.Element | null {
  if (!session.matchSnippets || session.matchSnippets.length === 0) {
    return null;
  }

  const firstMatch = session.matchSnippets[0];
  const rolePrefix = firstMatch.role === "user" ? "你:   " : "助手:";
  const roleColor = firstMatch.role === "user" ? "green" : "blue";

  return (
    <>
      <Text color={isActive ? "cyan" : roleColor} bold>
        {rolePrefix}{" "}
      </Text>
      <Text color={isActive ? "cyan" : undefined}>{firstMatch.before}</Text>
      <Text color="red" bold>
        {firstMatch.match}
      </Text>
      <Text color={isActive ? "cyan" : undefined}>{firstMatch.after}</Text>
    </>
  );
}

/** 会话项组件 */
function SessionItem({
  session,
  state,
}: {
  session: SessionInfo;
  state: SessionBrowserState;
}): JSX.Element {
  const originalIndex = state.startIndex + state.visibleSessions.indexOf(session);
  const isActive = originalIndex === state.activeIndex;
  const isDisabled = session.isCurrentSession;

  const prefix = isActive ? "❯ " : "  ";
  let additionalInfo = "";

  if (session.isCurrentSession) {
    additionalInfo = " (当前)";
  }

  if (
    state.searchQuery &&
    session.matchSnippets &&
    session.matchSnippets.length > 0
  ) {
    if (session.matchCount && session.matchCount > 1) {
      additionalInfo += ` (+${session.matchCount - 1} 个)`;
    }
  }

  const matchDisplay = state.searchQuery ? (
    <MatchSnippetDisplay session={session} isActive={isActive} />
  ) : null;

  const displayText = matchDisplay || session.displayName;

  return (
    <Box flexDirection="row" backgroundColor={isActive ? "blue" : undefined}>
      <Text color={isActive ? "cyan" : isDisabled ? "gray" : undefined}>
        {prefix}
      </Text>
      <Box width={5}>
        <Text color={isActive ? "cyan" : isDisabled ? "gray" : undefined}>
          #{originalIndex + 1}
        </Text>
      </Box>
      <Text color={isActive ? "cyan" : "gray"}> │ </Text>
      <Box width={4}>
        <Text color={isActive ? "cyan" : isDisabled ? "gray" : undefined}>
          {session.messageCount}
        </Text>
      </Box>
      <Text color={isActive ? "cyan" : "gray"}> │ </Text>
      <Box width={4}>
        <Text color={isActive ? "cyan" : isDisabled ? "gray" : undefined}>
          {formatRelativeTime(session.lastUpdated, "short")}
        </Text>
      </Box>
      <Text color={isActive ? "cyan" : "gray"}> │ </Text>
      <Box flexGrow={1}>
        <Text color={isActive ? "cyan" : isDisabled ? "gray" : undefined}>
          {displayText}
          {additionalInfo && (
            <Text color={isActive ? "cyan" : "gray"}>{additionalInfo}</Text>
          )}
        </Text>
      </Box>
    </Box>
  );
}

/** 会话列表组件 */
function SessionList({ state }: { state: SessionBrowserState }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {!state.isSearchMode && <NavigationHelpDisplay />}
        <SessionTableHeader state={state} />
      </Box>

      {state.visibleSessions.map((session) => (
        <SessionItem key={session.id} session={session} state={state} />
      ))}

      <Text color="gray">
        {state.endIndex < state.totalSessions ? "▼" : " "}
      </Text>
    </Box>
  );
}

/** 会话浏览器视图组件 */
function SessionBrowserView({ state }: { state: SessionBrowserState }): JSX.Element {
  if (state.loading) {
    return <SessionBrowserLoading />;
  }

  if (state.error) {
    return <SessionBrowserError error={state.error} />;
  }

  if (state.sessions.length === 0) {
    return <SessionBrowserEmpty />;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <SessionListHeader state={state} />
      {state.isSearchMode && <SearchModeDisplay query={state.searchQuery} />}
      {state.filteredAndSortedSessions.length === 0 ? (
        <NoResultsDisplay />
      ) : (
        <SessionList state={state} />
      )}
    </Box>
  );
}

/** 会话浏览器主组件 */
export function SessionBrowser({
  config,
  currentSessionId,
  onResumeSession,
  onDeleteSession,
  onExit,
}: SessionBrowserProps): JSX.Element {
  const state = useSessionBrowserState();
  const moveSelection = useMoveSelection(state);
  const cycleSortOrder = useCycleSortOrder(state);

  useLoadSessions(config, currentSessionId, state);
  useSessionBrowserInput(
    state,
    moveSelection,
    cycleSortOrder,
    onResumeSession,
    onDeleteSession,
    onExit
  );

  return <SessionBrowserView state={state} />;
}
