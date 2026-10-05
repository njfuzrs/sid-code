/** next 实现：Hooks 与 Context。上游已有的 4 个 hook 直接用，其余待实现。 */
import { createContext } from "react";
import { notImplementedFn } from "./not-implemented.ts";
// 共享时钟由底座在 render 时提供（T3.2）；CLI 读它、不提供它
export { ClockContext } from "@sid-code/tui/clock.ts";

export { useApp, useInput, useStdin, useStdout } from "@sid-code/tui";
export { default as useAnimationFrame } from "@sid-code/tui/hooks/use-animation-frame.ts";
export const useTerminalTitle = notImplementedFn("useTerminalTitle", "T7.2");
export const useTabStatus = notImplementedFn("useTabStatus", "T7.2");
// Context 必须是真的 Context 对象：CLI 用它做 Provider，换成会抛的占位物会在挂载时就崩，
// 连「最小 App 能启动」都做不到。新底座目前不读它们，所以这里只保证 CLI 侧的 Provider 能挂上。
// 由谁提供值、底座内部读不读，到 T3.3（TerminalSize）/ T3.2（Clock）/ T7.2（TerminalWrite）再定。
export const TerminalSizeContext = createContext<{ columns: number; rows: number } | null>(null);
export const TerminalWriteContext = createContext<((data: string) => void) | null>(null);
