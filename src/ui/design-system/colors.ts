/**
 * 设计系统:语义颜色解析 — P3-1
 *
 * 将设计系统对外暴露的语义颜色名(success/error/warning/...)解析为
 * 当前主题 `SemanticColors` token 树中的具体颜色值。
 *
 * 为什么单列纯函数:颜色解析是设计系统所有原子组件的公共依赖,
 * 抽成纯函数后可脱离 React 渲染单测,保证主题切换时映射稳定。
 */

import type { SemanticColors } from "../themes/semantic-tokens.ts";

/** 设计系统对外的语义颜色名 */
export type SemanticColorName =
  | "text" // 主文本
  | "subtle" // 次要信息
  | "inactive" // 非活跃
  | "link" // 链接
  | "success" // 成功
  | "error" // 错误
  | "warning" // 警告
  | "accent" // 强调
  | "border"; // 边框

/**
 * 将语义颜色名解析为具体颜色值。
 * 显式接收 colors,便于单测与主题切换。
 */
export function resolveSemanticColor(
  name: SemanticColorName,
  colors: SemanticColors,
): string {
  switch (name) {
    case "text":
      return colors.text.primary;
    case "subtle":
      return colors.text.secondary;
    case "inactive":
      return colors.ui.comment;
    case "link":
      return colors.text.link;
    case "success":
      return colors.status.success;
    case "error":
      return colors.status.error;
    case "warning":
      return colors.status.warning;
    case "accent":
      return colors.text.accent;
    case "border":
      return colors.border.default;
    default: {
      // 穷尽性检查:新增语义名而忘记映射时编译期报错
      const _exhaustive: never = name;
      void _exhaustive;
      return colors.text.primary;
    }
  }
}
