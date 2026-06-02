/**
 * 设计系统原子组件库 — P3-1
 *
 * 统一终端 UI 的颜色 / 边框 / 状态符号语义。
 * 现有组件可逐步迁移到这些原子组件(迁移为渐进式,不强制一次性替换)。
 */

export {
  resolveSemanticColor,
  type SemanticColorName,
} from "./colors.ts";
export { ThemedText, type ThemedTextProps } from "./ThemedText.tsx";
export { ThemedBox, type ThemedBoxProps } from "./ThemedBox.tsx";
export { Divider, dividerLine, type DividerProps } from "./Divider.tsx";
export {
  StatusIcon,
  statusSymbol,
  type StatusKind,
  type StatusIconProps,
} from "./StatusIcon.tsx";
