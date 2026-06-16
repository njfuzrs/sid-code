/**
 * 配置上下文
 *
 * 提供只读配置访问，各组件通过 useConfig() 获取。
 * 配置由外部 StateBridge 驱动更新。
 */

import React, { createContext, useContext, useMemo } from "react";
import type { PricingModelEntry } from "../../api/cost-tracker.ts";

export interface ConfigContextValue {
  /** 当前模型 */
  model: string;
  /** 当前提供商 */
  provider: string;
  /** 权限模式 */
  permissionMode: string;
  /** 是否处于计划模式（用于 TUI 状态标签显示） */
  isPlanMode: boolean;
  /** Git 分支 */
  gitBranch: string;
  /** 是否调试模式 */
  debug: boolean;
  /** 当前工作目录 */
  cwd: string;
  /** 所有已注册命令（补全用） */
  commands: Array<{ name: string; aliases: string[]; description: string }>;
  /** 可用模型列表（含 provider 信息，供 inferProvider 优先使用） */
  availableModels: PricingModelEntry[];
}

const ConfigCtx = createContext<ConfigContextValue | undefined>(undefined);

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigCtx);
  if (!ctx) {
    throw new Error("useConfig 必须在 ConfigProvider 内使用");
  }
  return ctx;
}

interface ConfigProviderProps {
  children: React.ReactNode;
  value: ConfigContextValue;
}

export const ConfigProvider: React.FC<ConfigProviderProps> = ({ children, value }) => {
  const memoized = useMemo(() => value, [
    value.model,
    value.provider,
    value.permissionMode,
    value.isPlanMode,
    value.gitBranch,
    value.debug,
    value.cwd,
    value.commands,
    value.availableModels,
  ]);

  return (
    <ConfigCtx.Provider value={memoized}>
      {children}
    </ConfigCtx.Provider>
  );
};
