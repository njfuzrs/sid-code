/**
 * UI 状态上下文
 * 管理全局 UI 状态，包括 renderMarkdown 开关、通知消息等
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from "react";

/** 瞬态消息类型 */
export enum TransientMessageType {
  Warning = "warning",
  Hint = "hint",
  Info = "info",
}

/** 瞬态消息 */
export interface TransientMessage {
  text: string;
  type: TransientMessageType;
}

/**
 * 瞬态消息的停留时长（ms）。
 *
 * 口径与 `ui/CLAUDE.md` L4-H「短回执 4s、错误 8s」一致（同族常量见
 * `ui/command-result-route.ts` 的 COMMAND_STATUS_MS / COMMAND_ERROR_STATUS_MS）。
 * 瞬态消息的语义就是「说完就走」——此前没有到期定时器，一旦显示就永久挂在
 * 输入框上方，直到进程退出（2026-11-03 粘贴提示滞留实测）。
 */
export const TRANSIENT_MESSAGE_MS = 4000;
export const TRANSIENT_WARNING_MS = 8000;

/** 工具结果阶梯式展开级别 — TO4
 * 0 = 折叠（默认行数截断）/ 1 = 展开更多（中间档）/ 2 = 全展开（不截断）。
 */
export type ExpandLevel = 0 | 1 | 2;

/** 各展开级别对应的最大显示行数（2 = 全展开用 Infinity）。
 *  对标 claude-code: MAX_LINES_TO_SHOW=3。 */
export const EXPAND_LEVEL_MAX_LINES: Record<ExpandLevel, number> = {
  0: 3,
  1: 50,
  2: Infinity,
};

/** TO4：阶梯循环下一级别（0→1→2→0）。纯函数，便于单测。 */
export function nextExpandLevel(level: ExpandLevel): ExpandLevel {
  return ((level + 1) % 3) as ExpandLevel;
}

/** TO4：旧 constrainHeight 布尔到展开级别的兼容映射（true→0 折叠，false→2 全展开）。 */
export function expandLevelFromConstrain(constrain: boolean): ExpandLevel {
  return constrain ? 0 : 2;
}

/** UI 状态 */
export interface UIState {
  /** 是否渲染 Markdown（false 时显示原始 Markdown 文本） */
  renderMarkdown: boolean;
  /** 瞬态消息（自动消失） */
  transientMessage: TransientMessage | null;
  /** 是否显示溢出提示（Ctrl+O 显示更多） */
  showIsExpandableHint: boolean;
  /** 是否限制高度（派生自 expandLevel===0，保留向后兼容） */
  constrainHeight: boolean;
  /** TO4：工具结果阶梯式展开级别（0 折叠 / 1 更多 / 2 全展开） */
  expandLevel: ExpandLevel;
  /** Ctrl+C 按下一次 */
  ctrlCPressedOnce: boolean;
  /** Ctrl+D 按下一次 */
  ctrlDPressedOnce: boolean;
  /** 是否显示 Escape 提示 */
  showEscapePrompt: boolean;
  /** 对话框是否可见（统一控制：对话框和输入区互斥） */
  dialogsVisible: boolean;
  /** Ctrl+T 隐藏后台任务面板（仅隐藏 UI，任务照常运行）。默认 false=显示。 */
  taskPanelHidden: boolean;
  /**
   * 输入框当前是否为空的**可变引用**（不参与渲染）。
   *
   * 用途：App 的 Esc 双击门控要在 keypress handler 里读它——那类闭包会拿到上一帧的
   * state，所以必须读 ref；而这个值不参与任何渲染，用 state 会让每敲一个字符就重渲整棵树。
   * 约定：InputArea 在 buffer 变化时写入，App 只读。
   * ⚠️ 别拿 `App.tsx` 里那个 `isEmpty` 顶替，它的含义是「历史为空且不在流式输出」。
   */
  inputEmptyRef: { current: boolean };
}

/** UI 操作 */
export interface UIActions {
  setRenderMarkdown: (value: boolean) => void;
  toggleRenderMarkdown: () => void;
  setTransientMessage: (message: TransientMessage | null) => void;
  showTransientMessage: (text: string, type: TransientMessageType, ttlMs?: number) => void;
  setShowIsExpandableHint: (value: boolean) => void;
  setConstrainHeight: (value: boolean | ((prev: boolean) => boolean)) => void;
  /** TO4：循环切换工具结果展开级别（0→1→2→0）。 */
  cycleExpandLevel: () => void;
  /** TO4：直接设定展开级别。 */
  setExpandLevel: (level: ExpandLevel) => void;
  setCtrlCPressedOnce: (value: boolean) => void;
  setCtrlDPressedOnce: (value: boolean) => void;
  setShowEscapePrompt: (value: boolean) => void;
  setDialogsVisible: (value: boolean) => void;
  /** Ctrl+T：切换后台任务面板显隐。 */
  toggleTaskPanel: () => void;
}

const UIStateContext = createContext<UIState | undefined>(undefined);
const UIActionsContext = createContext<UIActions | undefined>(undefined);

export const useUIState = (): UIState => {
  const context = useContext(UIStateContext);
  if (!context) {
    throw new Error("useUIState must be used within a UIStateProvider");
  }
  return context;
};

export const useUIActions = (): UIActions => {
  const context = useContext(UIActionsContext);
  if (!context) {
    throw new Error("useUIActions must be used within a UIStateProvider");
  }
  return context;
};

/**
 * 容错读取当前全局 expandLevel。
 *
 * 与 useUIState 不同：无 Provider 时不抛错，回退到折叠档（level 0）。
 * 供 CommandMessage / ErrorMessage 等展示组件使用——它们生产中始终在
 * UIStateProvider 下（拿到真实 expandLevel），但单测可不包 Provider 直接渲染。
 */
export const useExpandLevel = (): ExpandLevel => {
  const context = useContext(UIStateContext);
  return context?.expandLevel ?? 0;
};

/**
 * 把当前全局 expandLevel 解析为有效最大显示行数。
 *
 * 收口 expandLevel → maxLines 的映射（此前内联在 ToolResultDisplay），
 * 让任意折叠区（命令输出、错误正文等）都能用同一套 ctrl+o 阶梯展开语义：
 * - 取 base（折叠档基线）与该级别上限的较大值，确保调用方显式要求更多行时不被缩小；
 * - 全展开档（Infinity）返回 undefined，交由下游不截断。
 *
 * 容错：无 Provider 时回退折叠档（level 0），不抛错（便于展示组件单测）。
 *
 * @param base 折叠档（level 0）的基线行数，默认 3（对标 cc MAX_LINES_TO_SHOW）。
 */
export const useExpandedMaxLines = (base = 3): number | undefined => {
  const expandLevel = useExpandLevel();
  const levelMaxLines = EXPAND_LEVEL_MAX_LINES[expandLevel];
  return levelMaxLines === Infinity ? undefined : Math.max(base, levelMaxLines);
};

interface UIStateProviderProps {
  children: React.ReactNode;
}

export const UIStateProvider: React.FC<UIStateProviderProps> = ({ children }) => {
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [transientMessage, setTransientMessageState] = useState<TransientMessage | null>(null);
  const [showIsExpandableHint, setShowIsExpandableHint] = useState(false);
  const [expandLevel, setExpandLevelState] = useState<ExpandLevel>(0);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [dialogsVisible, setDialogsVisible] = useState(false);
  const [taskPanelHidden, setTaskPanelHidden] = useState(false);
  // A1：输入框是否为空——用 ref 而不是 state，理由见 UIState.inputEmptyRef 注释。
  const inputEmptyRef = useRef(true);

  // 瞬态消息的到期定时器：新消息覆盖旧消息时必须作废旧定时器，
  // 否则旧定时器会按「上一条」的时长把新消息提前清掉。
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTransientTimer = useCallback(() => {
    if (transientTimerRef.current) {
      clearTimeout(transientTimerRef.current);
      transientTimerRef.current = null;
    }
  }, []);

  /**
   * 写入 / 手动清除瞬态消息（统一入口，先作废旧定时器）。
   *
   * 手动清空走的是这个包装而不是裸 setState：否则「调 setTransientMessage(null)
   * 之后又立刻 show 一条新消息」时，旧定时器仍会到点把新消息清掉。
   */
  const setTransientMessage = useCallback(
    (message: TransientMessage | null) => {
      clearTransientTimer();
      setTransientMessageState(message);
    },
    [clearTransientTimer],
  );

  /**
   * 显示一条瞬态消息，到点自动消失（Warning 8s，Hint / Info 4s，口径见
   * {@link TRANSIENT_MESSAGE_MS}）。
   *
   * 此前这里只 setState 不挂定时器，全仓也没有任何一处清空 —— 消息一旦显示就永久
   * 挂在输入框上方直到进程退出（2026-11-03 实测：粘贴一次后两行「剪贴板无图片…」
   * 一直不消失）。「瞬态」这个名字必须由到期自动清除来实现。
   */
  const showTransientMessage = useCallback(
    (text: string, type: TransientMessageType, ttlMs?: number) => {
      setTransientMessage({ text, type });
      const ttl =
        ttlMs ??
        (type === TransientMessageType.Warning ? TRANSIENT_WARNING_MS : TRANSIENT_MESSAGE_MS);
      transientTimerRef.current = setTimeout(() => {
        transientTimerRef.current = null;
        setTransientMessageState(null);
      }, ttl);
    },
    [setTransientMessage],
  );

  // Provider 卸载时清掉未到期的定时器，避免已销毁的组件被回调 setState。
  useEffect(() => clearTransientTimer, [clearTransientTimer]);

  const toggleRenderMarkdown = useCallback(() => {
    setRenderMarkdown((prev) => !prev);
  }, []);

  const toggleTaskPanel = useCallback(() => {
    setTaskPanelHidden((prev) => !prev);
  }, []);

  // TO4：constrainHeight 派生自 expandLevel（0=约束，≥1=放开），保留旧语义。
  const constrainHeight = expandLevel === 0;

  const state = useMemo<UIState>(
    () => ({
      renderMarkdown,
      transientMessage,
      showIsExpandableHint,
      constrainHeight,
      expandLevel,
      ctrlCPressedOnce,
      ctrlDPressedOnce,
      showEscapePrompt,
      dialogsVisible,
      taskPanelHidden,
      inputEmptyRef,
    }),
    [
      renderMarkdown,
      transientMessage,
      showIsExpandableHint,
      constrainHeight,
      expandLevel,
      ctrlCPressedOnce,
      ctrlDPressedOnce,
      showEscapePrompt,
      dialogsVisible,
      taskPanelHidden,
      inputEmptyRef,
    ],
  );

  const actions = useMemo<UIActions>(
    () => ({
      setRenderMarkdown,
      toggleRenderMarkdown,
      setTransientMessage,
      showTransientMessage,
      setShowIsExpandableHint,
      // TO4：兼容旧 setConstrainHeight 语义——true→级别0(折叠)，false→级别2(全展开)。
      setConstrainHeight: (value: boolean | ((prev: boolean) => boolean)) => {
        setExpandLevelState((prevLevel) => {
          const prevConstrain = prevLevel === 0;
          const next = typeof value === "function" ? value(prevConstrain) : value;
          return expandLevelFromConstrain(next);
        });
      },
      // TO4：阶梯循环 0→1→2→0。
      cycleExpandLevel: () => {
        setExpandLevelState((prev) => nextExpandLevel(prev));
      },
      setExpandLevel: (level: ExpandLevel) => setExpandLevelState(level),
      setCtrlCPressedOnce,
      setCtrlDPressedOnce,
      setShowEscapePrompt,
      setDialogsVisible,
      toggleTaskPanel,
    }),
    [toggleRenderMarkdown, showTransientMessage, toggleTaskPanel],
  );

  return (
    <UIStateContext.Provider value={state}>
      <UIActionsContext.Provider value={actions}>{children}</UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
};
