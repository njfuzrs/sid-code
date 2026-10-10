/**
 * Hooks 与 Context。按 `SID_TUI_RENDERER` 选 legacy / next 实现，见 README.md 与 select.ts。
 *
 * 两边都是字面量动态 import，`bun build --compile` 会把两套都打进产物（D-4），
 * 运行时只求值选中的那一套。next 的类型按 legacy 断言：新底座要实现的就是 legacy 的端口面。
 */
import { RENDERER } from "./select.ts";
import type * as Impl from "./legacy/hooks.ts";

const impl: typeof Impl =
  RENDERER === "next"
    ? ((await import("./next/hooks.ts")) as unknown as typeof Impl)
    : await import("./legacy/hooks.ts");

export const {
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
} = impl;
