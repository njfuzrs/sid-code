/**
 * Hooks 与 Context。实现在 `next/hooks.ts`（底座 `packages/tui`），见 README.md。
 */
export {
  useStdout,
  useStdin,
  useInput,
  useApp,
  useAnimationFrame,
  useTerminalTitle,
  useTabStatus,
  TerminalSizeContext,
  ClockContext,
  TerminalWriteContext,
} from "./next/hooks.ts";
