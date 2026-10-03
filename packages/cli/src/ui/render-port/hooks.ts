/** Hooks 与 Context。见 README.md。 */
export { default as useStdout } from "@sid-code/tui-renderer/_vendor/use-stdout.ts";
export { default as useStdin } from "@sid-code/tui-renderer/hooks/use-stdin.ts";
export { default as useInput } from "@sid-code/tui-renderer/hooks/use-input.ts";
export { default as useApp } from "@sid-code/tui-renderer/hooks/use-app.ts";
export { useAnimationFrame } from "@sid-code/tui-renderer/hooks/use-animation-frame.ts";
export { useTerminalTitle } from "@sid-code/tui-renderer/hooks/use-terminal-title.ts";
export { useTabStatus } from "@sid-code/tui-renderer/hooks/use-tab-status.ts";
export { TerminalSizeContext } from "@sid-code/tui-renderer/components/TerminalSizeContext.tsx";
export { ClockContext } from "@sid-code/tui-renderer/components/ClockContext.tsx";
export { TerminalWriteContext } from "@sid-code/tui-renderer/useTerminalNotification.ts";
