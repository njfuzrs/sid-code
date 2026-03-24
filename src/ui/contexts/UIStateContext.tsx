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
  /** 是否限制高度 */
  constrainHeight: boolean;
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
  const [constrainHeight, setConstrainHeight] = useState(true);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [dialogsVisible, setDialogsVisible] = useState(false);

  const toggleRenderMarkdown = useCallback(() => {
    setRenderMarkdown(prev => !prev);
  }, []);

  const showTransientMessage = useCallback((text: string, type: TransientMessageType) => {
    setTransientMessage({ text, type });
  }, []);

  const state = useMemo<UIState>(() => ({
    renderMarkdown,
    transientMessage,
    updateInfo,
    showIsExpandableHint,
    constrainHeight,
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
    setConstrainHeight: (value: boolean | ((prev: boolean) => boolean)) => {
      if (typeof value === 'function') {
        setConstrainHeight(prev => value(prev));
      } else {
        setConstrainHeight(value);
      }
    },
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
