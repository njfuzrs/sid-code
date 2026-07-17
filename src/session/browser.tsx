/**
 * 会话浏览器 TUI 组件
 * 提供交互式会话选择、搜索、删除功能
 */

import React, { useState, useCallback, useMemo, useEffect } from "react";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import useStdout from "../ink/_vendor/use-stdout.js";
import type { Config } from "../config/config.ts";
import type { SessionInfo } from "./utils.ts";
import {
  getSessionFiles,
  formatRelativeTime,
  formatAbsoluteTime,
  shortenModel,
  filterSessions,
  sortSessions,
} from "./utils.ts";
import { theme } from "../ui/semantic-colors.ts";
import { homedir } from "os";
import { sidPaths } from "../config/paths.ts";

/** 把绝对路径中的 home 前缀缩成 ~，元信息行展示项目路径用 */
function shortenPath(p: string | undefined): string {
  if (!p) return "";
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * 每条会话占用的终端行数：标题 1 行 + 元信息 1 行 + marginBottom 1 行 = 3 行。
 * 用于按终端高度反推一屏能放几条。
 */
const ROWS_PER_SESSION = 3;

/**
 * 列表区之外的固定行开销（不随会话数变化的部分）：
 *   标题 1 + 搜索框(round 边框上下 2 + 内容 1 = 3) + 列表上 margin 1
 *   + 上/下溢出指示各 1(共 2) + footer(上 margin 1 + 本体 1 = 2) + 安全余量 2
 * 端末行数减去这部分,剩下的除以每条行数,就是一屏能放的会话数。
 */
const FIXED_CHROME_ROWS = 11;

/** 兜底每页会话数（拿不到终端高度时用）。 */
const FALLBACK_SESSIONS_PER_PAGE = 8;

/** 每页最少显示的会话数,避免终端过矮时算出 0 或负数。 */
const MIN_SESSIONS_PER_PAGE = 3;

/**
 * 按终端高度计算一屏能放几条会话。
 * 关键:必须让「固定开销 + 会话行 + 溢出指示」的总高度 ≤ 终端行数,
 * 否则整个选择器高于终端 → 终端自身出现滚动条,方向键下翻变成终端滚动到底部,
 * 顶部信息被顶出视口(用户反馈的 bug)。
 */
function computeSessionsPerPage(terminalRows: number | undefined): number {
  if (!terminalRows || terminalRows <= 0) {
    return FALLBACK_SESSIONS_PER_PAGE;
  }
  const usable = terminalRows - FIXED_CHROME_ROWS;
  const count = Math.floor(usable / ROWS_PER_SESSION);
  return Math.max(MIN_SESSIONS_PER_PAGE, count);
}

/** 会话浏览器属性 */
export interface SessionBrowserProps {
  config: Config;
  currentSessionId?: string;
  onResumeSession: (session: SessionInfo) => void;
  onDeleteSession: (session: SessionInfo) => Promise<void>;
  onExit: () => void;
  /**
   * 进入即搜索模式（对标 claude-code `-r` 的选择器：一进来就是搜索框，输入即过滤）。
   * 此模式下搜索框为空时按 Esc 直接退出选择器（而非切回导航模式）。
   */
  searchFirst?: boolean;
  /** 预填搜索词（`-r <term>` 未精确命中 ID 时把 term 带进选择器）。 */
  initialSearchQuery?: string;
  /**
   * 当前项目根（启动 cwd 的 git 根，无 git 时为 cwd）。用于 Ctrl+P「仅当前项目」筛选：
   * 只保留 cwd 落在该根目录下的会话。不传则禁用项目筛选（Ctrl+P 无效）。
   */
  projectRoot?: string;
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

  // 项目筛选状态：true = 仅当前项目，false = 全部（默认）
  projectOnly: boolean;

  // 计算值
  totalSessions: number;
  startIndex: number;
  endIndex: number;
  visibleSessions: SessionInfo[];
  /** 一屏能放几条会话（按终端高度动态计算，防止选择器高于终端出滚动条） */
  sessionsPerPage: number;

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
  setProjectOnly: React.Dispatch<React.SetStateAction<boolean>>;
}

/** 状态管理 Hook */
function useSessionBrowserState(
  initialSessions: SessionInfo[] = [],
  initialLoading = true,
  initialError: string | null = null,
  initialSearchQuery = "",
  initialSearchMode = false,
  projectRoot?: string,
  sessionsPerPage: number = FALLBACK_SESSIONS_PER_PAGE
): SessionBrowserState {
  const [sessions, setSessions] = useState<SessionInfo[]>(initialSessions);
  const [loading, setLoading] = useState(initialLoading);
  const [error, setError] = useState<string | null>(initialError);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [sortOrder, setSortOrder] = useState<"date" | "messages" | "name">("date");
  // 默认按时间倒序（最近的在最上面）——用户定位会话优先看最近聊过的。
  // sortSessions 的 date 是升序（旧→新），reverse=true 翻成降序（新→旧）。
  const [sortReverse, setSortReverse] = useState(true);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [isSearchMode, setIsSearchMode] = useState(initialSearchMode);
  const [hasLoadedFullContent, setHasLoadedFullContent] = useState(false);
  // 默认 false = 列全部会话（用户选择：全局全部为默认，Ctrl+P 切「仅当前项目」）
  const [projectOnly, setProjectOnly] = useState(false);

  const filteredAndSortedSessions = useMemo(() => {
    // 项目筛选：projectOnly 且有 projectRoot 时，只留 cwd 落在项目根下的会话。
    // 用路径前缀匹配（带分隔符，避免 /a/proj 误匹配 /a/proj-foo）。
    let base = sessions;
    if (projectOnly && projectRoot) {
      const root = projectRoot.replace(/\/+$/, "");
      base = sessions.filter((s) => {
        if (!s.cwd) return false;
        const c = s.cwd.replace(/\/+$/, "");
        return c === root || c.startsWith(root + "/");
      });
    }
    const filtered = filterSessions(base, searchQuery);
    return sortSessions(filtered, sortOrder, sortReverse);
  }, [sessions, searchQuery, sortOrder, sortReverse, projectOnly, projectRoot]);

  // 搜索清空时重置完整内容标志
  useEffect(() => {
    if (!searchQuery) {
      setHasLoadedFullContent(false);
    }
  }, [searchQuery]);

  const totalSessions = filteredAndSortedSessions.length;
  const startIndex = scrollOffset;
  const endIndex = Math.min(scrollOffset + sessionsPerPage, totalSessions);
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
    projectOnly,
    setProjectOnly,
    filteredAndSortedSessions,
    totalSessions,
    startIndex,
    endIndex,
    visibleSessions,
    sessionsPerPage,
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
        // P0-1：传 sessions 根目录 → getSessionFiles 跨所有项目子目录聚合（选择器默认「全部项目」视图）。
        const sessionDir = sidPaths.sessions();
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
          const sessionDir = sidPaths.sessions();
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
    sessionsPerPage,
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
      } else if (newIndex >= scrollOffset + sessionsPerPage) {
        setScrollOffset(newIndex - sessionsPerPage + 1);
      }
    },
    [
      totalSessions,
      activeIndex,
      scrollOffset,
      sessionsPerPage,
      setActiveIndex,
      setScrollOffset,
    ]
  );
}

/**
 * 环绕式移动 Hook（用于 ↑/↓ 单步）：到底再往下回到第一条，到顶再往上回到最后一条。
 * 与 useMoveSelection 的区别是不 clamp，而是对 totalSessions 取模实现无限滚动。
 * scrollOffset 追随新 index：跳到列表两端时把目标行滚进可视窗口。
 */
function useWrapSelection(state: SessionBrowserState) {
  const {
    totalSessions,
    activeIndex,
    scrollOffset,
    sessionsPerPage,
    setActiveIndex,
    setScrollOffset,
  } = state;

  return useCallback(
    (delta: number) => {
      if (totalSessions <= 0) return;
      // 取模环绕：+totalSessions 再取模，保证负数（往上越界）也落到正确区间。
      const newIndex =
        (((activeIndex + delta) % totalSessions) + totalSessions) %
        totalSessions;
      setActiveIndex(newIndex);

      // 滚动窗口跟随:目标行在窗口上方→顶对齐;在窗口下方→底对齐。
      // 环绕到末尾时 newIndex 远大于当前窗口→底对齐把它滚进来;
      // 环绕到开头时 newIndex=0→顶对齐。
      if (newIndex < scrollOffset) {
        setScrollOffset(newIndex);
      } else if (newIndex >= scrollOffset + sessionsPerPage) {
        setScrollOffset(Math.max(0, newIndex - sessionsPerPage + 1));
      }
    },
    [
      totalSessions,
      activeIndex,
      scrollOffset,
      sessionsPerPage,
      setActiveIndex,
      setScrollOffset,
    ]
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
  wrapSelection: (delta: number) => void,
  cycleSortOrder: () => void,
  onResumeSession: (session: SessionInfo) => void,
  onDeleteSession: (session: SessionInfo) => Promise<void>,
  onExit: () => void,
  searchFirst = false,
  projectFilterEnabled = false
) {
  useInput((input, key) => {
    // Ctrl+P：在「全部 / 仅当前项目」间切换（两种模式下都生效，且不落进搜索框）。
    // 仅当调用方提供了 projectRoot（projectFilterEnabled）才启用。
    if (key.ctrl && input === "p") {
      if (projectFilterEnabled) {
        state.setProjectOnly((v) => !v);
        state.setActiveIndex(0);
        state.setScrollOffset(0);
      }
      return;
    }

    if (state.isSearchMode) {
      // 搜索模式
      if (key.escape) {
        // searchFirst（对标 CC `-r` 选择器）：搜索框已空时 Esc 直接退出选择器；
        // 有内容时 Esc 先清空。非 searchFirst 模式沿用旧行为（Esc 切回导航模式）。
        if (searchFirst) {
          if (state.searchQuery) {
            state.setSearchQuery("");
            state.setActiveIndex(0);
            state.setScrollOffset(0);
          } else {
            onExit();
          }
          return;
        }
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
        state.setScrollOffset(
          Math.max(0, state.totalSessions - state.sessionsPerPage)
        );
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
        moveSelection(-Math.round(state.sessionsPerPage / 2));
      } else if (input === "d") {
        moveSelection(Math.round(state.sessionsPerPage / 2));
      }
    }

    // 通用按键
    if (key.return && state.filteredAndSortedSessions[state.activeIndex]) {
      const selectedSession = state.filteredAndSortedSessions[state.activeIndex];
      if (!selectedSession.isCurrentSession) {
        onResumeSession(selectedSession);
      }
    } else if (key.upArrow) {
      wrapSelection(-1);
    } else if (key.downArrow) {
      wrapSelection(1);
    } else if (key.pageUp) {
      moveSelection(-state.sessionsPerPage);
    } else if (key.pageDown) {
      moveSelection(state.sessionsPerPage);
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

/**
 * 顶部标题 + 搜索框（对标 CC：带圆角边框的搜索输入，一眼就知道能打字）。
 * 无论导航还是搜索模式都渲染，只是搜索模式下光标可见 + 提示"输入以搜索"。
 */
function SearchHeader({
  state,
}: {
  state: SessionBrowserState;
}): JSX.Element {
  const hasQuery = Boolean(state.searchQuery);
  const scopeLabel = state.projectOnly ? "仅当前项目" : "全部项目";
  return (
    <Box flexDirection="column">
      <Text bold color={theme.text.accent}>
        恢复会话{" "}
        <Text color={theme.text.secondary}>
          （{scopeLabel} · {state.totalSessions} 个）
        </Text>
      </Text>
      <Box
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        marginTop={0}
      >
        <Text color={theme.ui.symbol}>⌕ </Text>
        {hasQuery ? (
          <Text color={theme.text.primary}>{state.searchQuery}</Text>
        ) : (
          <Text color={theme.text.secondary}>输入以搜索…</Text>
        )}
        {/* 闪烁光标位——静态下画一个块，示意可输入 */}
        <Text color={theme.ui.active}>▏</Text>
      </Box>
    </Box>
  );
}

/** 无结果显示组件 */
function NoResultsDisplay(): JSX.Element {
  return (
    <Box paddingX={1} paddingY={0}>
      <Text color={theme.text.secondary}>未找到匹配的会话</Text>
    </Box>
  );
}

/**
 * 匹配片段（搜索时替代元信息行的第二行）：命中词高亮。
 * CC 风格——用暗色包裹、命中词用告警色，不再用「你:/助手:」前缀噪声。
 */
function MatchSnippetLine({
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
  const dim = isActive ? theme.text.primary : theme.text.secondary;
  return (
    <Text wrap="truncate-end">
      <Text color={dim}>{"    " + firstMatch.before}</Text>
      <Text color={theme.status.warning} bold>
        {firstMatch.match}
      </Text>
      <Text color={dim}>{firstMatch.after}</Text>
    </Text>
  );
}

/**
 * 单条会话（CC 风格两行）：
 *   行 1  ❯ <标题>                          ← 选中项高亮，标题单行截断
 *   行 2    消息数 · 相对时间 · 项目路径      ← 暗色元信息，靠中点分隔（不用 │ 竖线对不齐）
 * 搜索时行 2 换成命中片段。选中行整体用左侧箭头 + 主色标题，不用背景块（避免整行刷蓝突兀）。
 */
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

  const titleColor = isActive
    ? theme.ui.active
    : isDisabled
      ? theme.text.secondary
      : theme.text.primary;
  const metaColor = isActive ? theme.text.primary : theme.text.secondary;

  // 元信息：北京时间(相对) · 消息数 · 模型 · 项目路径
  // 时间放首位——用户定位会话主要靠“什么时候聊的”，北京时间具体到分钟，
  // 括号里再附相对时间（如 2d/3h）便于快速估算新旧。
  const absTime = formatAbsoluteTime(session.lastUpdated);
  const relTime = formatRelativeTime(session.lastUpdated, "short");
  const metaParts = [
    absTime ? `${absTime} (${relTime})` : relTime,
    `${session.messageCount} 条`,
  ];
  const modelShort = shortenModel(session.model);
  if (modelShort) metaParts.push(modelShort);
  const cwdShort = shortenPath(session.cwd);
  if (cwdShort) metaParts.push(cwdShort);
  if (session.isCurrentSession) metaParts.push("当前");
  if (
    state.searchQuery &&
    session.matchCount &&
    session.matchCount > 1
  ) {
    metaParts.push(`+${session.matchCount - 1} 处匹配`);
  }

  const showMatch =
    Boolean(state.searchQuery) &&
    session.matchSnippets &&
    session.matchSnippets.length > 0;

  // 关键：每行用**单个** <Text wrap="truncate-end">，不套 flex-row + flexGrow 子项。
  // flex-row 里放可伸缩的 <Text> 时，vendored ink 对超宽 CJK 文本的测量会先按完整宽度
  // 布局再截断，导致多出一个空行（截图里每条会话下方的空行就是这么来的）。
  // 单 Text + 行内嵌套 <Text> 上色，既能截断又不折行。
  const arrow = isActive ? "❯ " : "  ";
  const indexLabel = `#${originalIndex + 1} `;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 行 1：箭头 + 序号 + 标题 */}
      <Text wrap="truncate-end">
        <Text color={isActive ? theme.ui.active : theme.text.secondary}>
          {arrow}
        </Text>
        <Text color={metaColor}>{indexLabel}</Text>
        <Text bold={isActive} color={titleColor}>
          {session.displayName}
        </Text>
      </Text>
      {/* 行 2：元信息 或 命中片段 */}
      {showMatch ? (
        <MatchSnippetLine session={session} isActive={isActive} />
      ) : (
        <Text wrap="truncate-end" color={metaColor} dimColor={!isActive}>
          {"    " + metaParts.join("  ·  ")}
        </Text>
      )}
    </Box>
  );
}

/** 会话列表组件（滚动窗口 + 上下溢出指示） */
function SessionList({ state }: { state: SessionBrowserState }): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      {state.scrollOffset > 0 && (
        <Text color={theme.text.secondary}>  ▲ 还有更新的会话</Text>
      )}
      {state.visibleSessions.map((session) => (
        <SessionItem key={session.id} session={session} state={state} />
      ))}
      {state.endIndex < state.totalSessions && (
        <Text color={theme.text.secondary}>  ▼ 还有更早的会话</Text>
      )}
    </Box>
  );
}

/**
 * 底部功能提示栏（对标 CC 的 "Type to search · Enter to select · Esc to cancel"）。
 * 按当前模式自适应：始终可"输入即搜索"，故常驻提示；Esc 语义随查询状态变化。
 */
function FooterHints({
  state,
  searchFirst,
  projectFilterEnabled,
}: {
  state: SessionBrowserState;
  searchFirst?: boolean;
  projectFilterEnabled?: boolean;
}): JSX.Element {
  // 关键：提示只列**当前模式下真正生效**的键，避免误导。
  // 搜索模式里 s/x/q 都是往查询里打字，不能当快捷键宣传——那里只留导航/恢复/退出/项目切换。
  // Ctrl+P 两种模式下都生效（在 useInput 顶部处理），故都列出（前提是启用了项目筛选）。
  const projectHint = projectFilterEnabled
    ? `Ctrl+P ${state.projectOnly ? "看全部" : "仅本项目"}`
    : null;
  let hints: (string | null)[];
  if (state.isSearchMode) {
    const escHint =
      searchFirst && !state.searchQuery ? "Esc 退出" : "Esc 清空/退出";
    hints = ["输入以搜索", "↑↓ 移动", "Enter 恢复", projectHint, escHint];
  } else {
    const sortLabel = { date: "时间", messages: "消息数", name: "名称" }[
      state.sortOrder
    ];
    hints = [
      "↑↓ 移动",
      "Enter 恢复",
      "/ 搜索",
      "x 删除",
      `s 排序(${sortLabel}${state.sortReverse ? "↓" : "↑"})`,
      projectHint,
      "q 退出",
    ];
  }
  return (
    <Box marginTop={1}>
      <Text color={theme.text.secondary} wrap="truncate-end">
        {hints.filter(Boolean).join("  ·  ")}
      </Text>
    </Box>
  );
}

/** 会话浏览器视图组件 */
function SessionBrowserView({
  state,
  searchFirst,
  projectFilterEnabled,
}: {
  state: SessionBrowserState;
  searchFirst?: boolean;
  projectFilterEnabled?: boolean;
}): JSX.Element {
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
      <SearchHeader state={state} />
      {state.filteredAndSortedSessions.length === 0 ? (
        <NoResultsDisplay />
      ) : (
        <SessionList state={state} />
      )}
      <FooterHints
        state={state}
        searchFirst={searchFirst}
        projectFilterEnabled={projectFilterEnabled}
      />
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
  searchFirst = false,
  initialSearchQuery = "",
  projectRoot,
}: SessionBrowserProps): JSX.Element {
  // 按终端高度动态算一屏能放几条会话——防止选择器整体高于终端行数,
  // 否则终端自身出滚动条,方向键下翻会把顶部信息顶出视口(用户反馈的 bug)。
  // useStdout 的 rows 是响应式的(随终端 resize 更新),窗口拉高/缩小会自动重算。
  const { stdout } = useStdout();
  const sessionsPerPage = computeSessionsPerPage(stdout?.rows);

  // searchFirst 时进入即搜索模式；若带了预填搜索词也自动进搜索模式便于继续编辑。
  const state = useSessionBrowserState(
    [],
    true,
    null,
    initialSearchQuery,
    searchFirst || Boolean(initialSearchQuery),
    projectRoot,
    sessionsPerPage
  );
  const moveSelection = useMoveSelection(state);
  const wrapSelection = useWrapSelection(state);
  const cycleSortOrder = useCycleSortOrder(state);

  useLoadSessions(config, currentSessionId, state);
  useSessionBrowserInput(
    state,
    moveSelection,
    wrapSelection,
    cycleSortOrder,
    onResumeSession,
    onDeleteSession,
    onExit,
    searchFirst,
    Boolean(projectRoot)
  );

  return (
    <SessionBrowserView
      state={state}
      searchFirst={searchFirst}
      projectFilterEnabled={Boolean(projectRoot)}
    />
  );
}
