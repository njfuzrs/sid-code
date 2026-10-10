/** next 实现：Hooks 与 Context。上游已有的 4 个 hook 直接用，其余在 @sid-code/tui 里新写。 */
// 共享时钟由底座在 render 时提供（T3.2）；CLI 读它、不提供它
export { ClockContext } from "@sid-code/tui/clock.ts";

import { useContext, useMemo } from "react";
import { useStdout as useInkStdout } from "@sid-code/tui";
import TerminalSizeContext from "@sid-code/tui/components/TerminalSizeContext.ts";

export { useApp, useInput, useStdin } from "@sid-code/tui";
export { default as useAnimationFrame } from "@sid-code/tui/hooks/use-animation-frame.ts";
export { useTerminalTitle } from "@sid-code/tui/hooks/use-terminal-title.ts";
export { useTabStatus } from "@sid-code/tui/hooks/use-tab-status.ts";
// 底座在 render 时提供原始写入口，CLI 只读（T7.2b，契约 O3）
export { default as TerminalWriteContext } from "@sid-code/tui/components/TerminalWriteContext.ts";
// 终端尺寸由底座在 render 时提供、resize 时更新（T8.1d）；CLI 的 TerminalContext 只读它。
// 以前这里是 CLI 自己 createContext(null)，没人 Provide → 拖窗口后根 Box 宽度不跟。
export { TerminalSizeContext };

/**
 * 与 legacy 的 `useStdout` 同一端口面（T8.1d）：`stdout.columns / rows` 取 TerminalSizeContext，
 * 并因为订阅了它，resize 时调用方会重渲。上游 hook 只返回裸 stdout，13 个读 `stdout.columns`
 * 的 CLI 组件（Composer / InputArea / 消息渲染…）在 resize 时没有任何值变化，宽度就停在旧值。
 * `write` / `on` 等方法照旧落在真实流上。
 */
export function useStdout() {
  const { stdout, write } = useInkStdout();
  const size = useContext(TerminalSizeContext);
  return useMemo(() => {
    const proxied = new Proxy(stdout, {
      get(target, prop) {
        if (prop === "columns") return size?.columns ?? target.columns ?? 80;
        if (prop === "rows") return size?.rows ?? target.rows ?? 24;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as NodeJS.WriteStream & { columns: number; rows: number };
    return { stdout: proxied, write };
  }, [stdout, write, size]);
}
