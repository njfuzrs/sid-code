/**
 * 用户设置上下文
 *
 * 提供可热更新的用户设置，各组件通过 useSettings() 获取。
 * 参考 gemini-cli SettingsContext.tsx
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

/** 用户设置 */
export interface Settings {
  /** 是否渲染 Markdown */
  renderMarkdown: boolean;
  /** 是否限制高度（代码块等） */
  constrainHeight: boolean;
  /** 是否隐藏行号 */
  hideLineNumbers: boolean;
  /** 主题名称 */
  theme: string;
  /** 是否启用 Vim 模式 */
  vimMode: boolean;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  renderMarkdown: true,
  constrainHeight: true,
  hideLineNumbers: false,
  theme: "default",
  vimMode: false,
};

interface SettingsContextValue {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
}

const SettingsCtx = createContext<SettingsContextValue | undefined>(undefined);

export function useSettings(): Settings {
  const ctx = useContext(SettingsCtx);
  if (!ctx) {
    throw new Error("useSettings 必须在 SettingsProvider 内使用");
  }
  return ctx.settings;
}

export function useSettingsActions(): { updateSettings: (patch: Partial<Settings>) => void } {
  const ctx = useContext(SettingsCtx);
  if (!ctx) {
    throw new Error("useSettingsActions 必须在 SettingsProvider 内使用");
  }
  return { updateSettings: ctx.updateSettings };
}

interface SettingsProviderProps {
  children: React.ReactNode;
  initialSettings?: Partial<Settings>;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({
  children,
  initialSettings,
}) => {
  const [settings, setSettings] = useState<Settings>({
    ...DEFAULT_SETTINGS,
    ...initialSettings,
  });

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings(prev => ({ ...prev, ...patch }));
  }, []);

  const value = useMemo(() => ({
    settings,
    updateSettings,
  }), [settings, updateSettings]);

  return (
    <SettingsCtx.Provider value={value}>
      {children}
    </SettingsCtx.Provider>
  );
};
