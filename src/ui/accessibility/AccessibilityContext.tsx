/**
 * 无障碍上下文 — LY2
 *
 * 统一提供「是否启用无障碍模式」给全 app 消费。来源：
 * - 启动时由 detectScreenReader() 探测（环境变量 + 显式开关）
 * - 可由设置/命令运行时切换
 *
 * 各组件据此降级：
 * - 动画（spinner / shimmer）→ 静态文本
 * - 仅靠颜色区分的信息 → 附加符号/文字前缀
 * - 关键交互区 → 附加可朗读的语义标签（aria 风格前缀）
 *
 * 对齐 claude-code 的无障碍模式开关；role/aria 在终端无 DOM 对应，落地为
 * 「语义前缀文本 + 动画降级」这一终端可行形态。
 */

import React, {
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";
import { detectScreenReader } from "./detect.ts";

export interface AccessibilityContextValue {
  /** 是否启用无障碍模式。 */
  enabled: boolean;
  /** 运行时切换。 */
  setEnabled: (value: boolean) => void;
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(
  null,
);

export function AccessibilityProvider({
  children,
  /** 测试可注入初值，跳过环境探测。 */
  initialEnabled,
}: {
  children: React.ReactNode;
  initialEnabled?: boolean;
}) {
  const [enabled, setEnabled] = useState<boolean>(
    initialEnabled ?? detectScreenReader(),
  );

  const value = useMemo<AccessibilityContextValue>(
    () => ({ enabled, setEnabled: (v: boolean) => setEnabled(v) }),
    [enabled],
  );

  return (
    <AccessibilityContext.Provider value={value}>
      {children}
    </AccessibilityContext.Provider>
  );
}

/**
 * 取无障碍状态。Provider 之外调用时降级为「关闭」，保证旧组件/孤立测试不破。
 */
export function useAccessibility(): AccessibilityContextValue {
  const ctx = useContext(AccessibilityContext);
  if (ctx) return ctx;
  return { enabled: false, setEnabled: () => {} };
}

/**
 * 便捷：仅取布尔值。
 */
export function useIsAccessibilityEnabled(): boolean {
  return useAccessibility().enabled;
}
