/**
 * 测试专用。render/lastFrame 走非 TTY 整帧输出，覆盖不到增量 diff（设计文档 §3 L1 的盲区）。按 `SID_TUI_RENDERER` 选 legacy / next 实现，见 README.md 与 select.ts。
 *
 * 两边都是字面量动态 import，`bun build --compile` 会把两套都打进产物（D-4），
 * 运行时只求值选中的那一套。next 的类型按 legacy 断言：新底座要实现的就是 legacy 的端口面。
 */
import { RENDERER } from "./select.ts";
import type * as Impl from "./legacy/testing.ts";

const impl: typeof Impl =
  RENDERER === "next"
    ? ((await import("./next/testing.ts")) as unknown as typeof Impl)
    : await import("./legacy/testing.ts");

export const { render, renderSync, forgetRenderInstance, enableFrameThrottle } = impl;
