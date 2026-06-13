/**
 * UI 状态上下文
 * 管理全局 UI 状态，包括 renderMarkdown 开关、通知消息等
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

/** 瞬态消息类型 */
export enum TransientMessageType {
  Warning = 'warning',
  Hint = 'hint',
  Info = 'info',
}

/** 瞬态消息 */
export interface TransientMessage {
  text: string;
  type: TransientMessageType;
}

/** 更新通知信息 */
export interface UpdateInfo {
  message: string;
  version?: string;
}

/** 工具结果阶梯式展开级别 — TO4
 * 0 = 折叠（默认行数截断）/ 1 = 展开更多（中间档）/ 2 = 全展开（不截断）。
 */
export type ExpandLevel = 0 | 1 | 2;

/** 各展开级别对应的最大显示行数（2 = 全展开用 Infinity）。 */
export const EXPAND_LEVEL_MAX_LINES: Record<ExpandLevel, number> = {
  0: 20,
  1: 100,
  2: Infinity,
};

/** TO4：阶梯循环下一级别（0→1→2→0）。纯函数，便于单测。 */
export function nextExpandLevel(level: ExpandLevel): ExpandLevel {
  return (((level + 1) % 3) as ExpandLevel);
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
  /** 更新通知 */
  updateInfo: UpdateInfo | null;
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
}

/** UI 操作 */
export interface UIActions {
  setRenderMarkdown: (value: boolean) => void;
  toggleRenderMarkdown: () => void;
  setTransientMessage: (message: TransientMessage | null) => void;
  showTransientMessage: (text: string, type: TransientMessageType) => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
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
}

const UIStateContext = createContext<UIState | undefined>(undefined);
const UIActionsContext = createContext<UIActions | undefined>(undefined);

export const useUIState = (): UIState => {
  const context = useContext(UIStateContext);
  if (!context) {
    throw new Error('useUIState must be used within a UIStateProvider');
  }
  return context;
};

export const useUIActions = (): UIActions => {
  const context = useContext(UIActionsContext);
  if (!context) {
    throw new Error('useUIActions must be used within a UIStateProvider');
  }
  return context;
};

interface UIStateProviderProps {
  children: React.ReactNode;
}

export const UIStateProvider: React.FC<UIStateProviderProps> = ({ children }) => {
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [transientMessage, setTransientMessage] = useState<TransientMessage | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showIsExpandableHint, setShowIsExpandableHint] = useState(false);
  const [expandLevel, setExpandLevelState] = useState<ExpandLevel>(0);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [dialogsVisible, setDialogsVisible] = useState(false);

  const toggleRenderMarkdown = useCallback(() => {
    setRenderMarkdown(prev => !prev);
  }, []);

  // TO4：constrainHeight 派生自 expandLevel（0=约束，≥1=放开），保留旧语义。
  const constrainHeight = expandLevel === 0;

  const showTransientMessage = useCallback((text: string, type: TransientMessageType) => {
    setTransientMessage({ text, type });
  }, []);

  const state = useMemo<UIState>(() => ({
    renderMarkdown,
    transientMessage,
    updateInfo,
    showIsExpandableHint,
    constrainHeight,
    expandLevel,
    ctrlCPressedOnce,
    ctrlDPressedOnce,
    showEscapePrompt,
    dialogsVisible,
  }), [
    renderMarkdown,
    transientMessage,
    updateInfo,
    showIsExpandableHint,
    constrainHeight,
    expandLevel,
    ctrlCPressedOnce,
    ctrlDPressedOnce,
    showEscapePrompt,
    dialogsVisible,
  ]);

  const actions = useMemo<UIActions>(() => ({
    setRenderMarkdown,
    toggleRenderMarkdown,
    setTransientMessage,
    showTransientMessage,
    setUpdateInfo,
    setShowIsExpandableHint,
    // TO4：兼容旧 setConstrainHeight 语义——true→级别0(折叠)，false→级别2(全展开)。
    setConstrainHeight: (value: boolean | ((prev: boolean) => boolean)) => {
      setExpandLevelState(prevLevel => {
        const prevConstrain = prevLevel === 0;
        const next = typeof value === "function" ? value(prevConstrain) : value;
        return expandLevelFromConstrain(next);
      });
    },
    // TO4：阶梯循环 0→1→2→0。
    cycleExpandLevel: () => {
      setExpandLevelState(prev => nextExpandLevel(prev));
    },
    setExpandLevel: (level: ExpandLevel) => setExpandLevelState(level),
    setCtrlCPressedOnce,
    setCtrlDPressedOnce,
    setShowEscapePrompt,
    setDialogsVisible,
  }), [toggleRenderMarkdown, showTransientMessage]);

  return (
    <UIStateContext.Provider value={state}>
      <UIActionsContext.Provider value={actions}>
        {children}
      </UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
};
