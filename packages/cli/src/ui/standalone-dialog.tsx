/**
 * 在主 TUI 之外临时挂一个 TUI 对话框，答完即卸载。
 *
 * 用途：不进主 TUI 的模式（目前只有 `--bridge`）仍有必须由本机的人确认的事。
 * 此前这类确认用 readline 在终端里问 `[y/N]`，与 TUI 审批框两套样式；
 * 现在统一用同一套 TUI 组件渲染，交互（↑↓ / Enter / Esc）与主 TUI 一致。
 */

import React from "react";
import { render } from "./render-port/runtime.ts";
import { KeypressProvider } from "./contexts/KeypressContext.tsx";

/**
 * 渲染 `build(done)` 返回的对话框，`done(value)` 被调用后卸载并返回该值。
 * 只调用第一次 done，后续调用忽略。
 */
export async function runStandaloneDialog<T>(
  build: (done: (value: T) => void) => React.ReactElement,
): Promise<T> {
  let resolveValue!: (v: T) => void;
  const result = new Promise<T>((r) => (resolveValue = r));
  let settled = false;
  const done = (v: T) => {
    if (settled) return;
    settled = true;
    resolveValue(v);
  };
  const instance = await render(<KeypressProvider>{build(done)}</KeypressProvider>, {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    return await result;
  } finally {
    instance.unmount();
  }
}
