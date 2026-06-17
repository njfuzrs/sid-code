/**
 * useTerminalIntegration 终端集成测试
 *
 * 验证三条真实写到终端 stdout 的字节链(用 vendored ink 的 render harness,
 * 它经 TerminalWriteContext 把 writeRaw 真实接到捕获的 stdout):
 * 1. OSC 0 终端标题——进行中带动画点前缀、其余带静态星号,且含 titleHint。
 * 2. OSC 9;4 进度环——进行中发 indeterminate(;3;)、回合结束发 clear(;0;)。
 * 3. 卸载时清进度环。
 *
 * 这些断言不依赖"肉眼能否看到 tab",而是直接证明序列字节发出且内容正确。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import React from "react";
import { render } from "../../ink/_vendor/testing.tsx";
import { useTerminalIntegration } from "./useTerminalIntegration.ts";
import { StreamingState } from "../types.ts";
import { TITLE_STATIC_PREFIX, TITLE_ANIMATION_FRAMES } from "../constants/figures.ts";

/** 极简宿主组件:只跑 hook,自身不渲染任何可见内容。 */
function Harness({
  streamingState,
  titleHint,
}: {
  streamingState: StreamingState;
  titleHint?: string;
}): React.ReactElement {
  useTerminalIntegration({ streamingState, titleHint });
  return React.createElement(React.Fragment, null);
}

/** OSC 0 标题序列:ESC ] 0 ; <text> BEL */
const OSC0 = "\x1b]0;";
/** OSC 2 标题序列:ESC ] 2 ; <text> BEL(xterm.js/VSCode 完整支持) */
const OSC2 = "\x1b]2;";
/** OSC 9;4 进度序列前缀:ESC ] 9 ; 4 ; */
const OSC94 = "\x1b]9;4;";

// 进度环 gate 依赖 isProgressReportingAvailable() → 读 TERM_PROGRAM 等 env +
// process.stdout.isTTY。render harness 的 stdout 是非 TTY,所以默认 gate=false,
// 进度环不发。为测进度链,显式把真实 process.stdout.isTTY 与 vscode env 打开。
let origEnv: Record<string, string | undefined>;
let origIsTTY: unknown;

beforeEach(() => {
  origEnv = {
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION,
    WT_SESSION: process.env.WT_SESSION,
    TMUX: process.env.TMUX,
  };
  origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
});

afterEach(() => {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (origIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", origIsTTY as PropertyDescriptor);
  }
});

/** 把进度环 gate 调成"可用"(模拟 VSCode 1.88+ 且 stdout 为 TTY)。 */
function enableProgressGate(): void {
  process.env.TERM_PROGRAM = "vscode";
  process.env.TERM_PROGRAM_VERSION = "1.124.2";
  delete process.env.WT_SESSION;
  delete process.env.TMUX;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
}

describe("TM2 终端标题(OSC 2 + OSC 0)", () => {
  test("空闲时同时发 OSC 2 与 OSC 0,带静态星号前缀 + titleHint", () => {
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Idle} titleHint="我的任务" />,
    );
    const out = stdout.get();
    // xterm.js/VSCode 完整支持 OSC 2,OSC 0 兜底传统终端——两条都必须发出。
    expect(out).toContain(`${OSC2}${TITLE_STATIC_PREFIX} 我的任务\x07`);
    expect(out).toContain(`${OSC0}${TITLE_STATIC_PREFIX} 我的任务\x07`);
    unmount();
  });

  test("进行中带动画点前缀(首帧),OSC 2 与 OSC 0 均发出", () => {
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Responding} titleHint="跑测试" />,
    );
    const out = stdout.get();
    // a11y 关闭时进行中用动画帧;挂载首帧固定为 TITLE_ANIMATION_FRAMES[0]。
    expect(out).toContain(`${OSC2}${TITLE_ANIMATION_FRAMES[0]} 跑测试\x07`);
    expect(out).toContain(`${OSC0}${TITLE_ANIMATION_FRAMES[0]} 跑测试\x07`);
    unmount();
  });

  test("无 titleHint 时回退 sid-code,标题仍发出", () => {
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Idle} />,
    );
    const out = stdout.get();
    expect(out).toContain(`${OSC2}${TITLE_STATIC_PREFIX} sid-code\x07`);
    expect(out).toContain(`${OSC0}${TITLE_STATIC_PREFIX} sid-code\x07`);
    unmount();
  });
});

describe("OSC 9;4 进度环", () => {
  test("gate 可用 + 进行中 → 发 indeterminate(;3;)", () => {
    enableProgressGate();
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Responding} titleHint="x" />,
    );
    // ESC]9;4;3; → state=3=indeterminate
    expect(stdout.get()).toContain(`${OSC94}3;`);
    unmount();
  });

  test("gate 可用 + 空闲 → 不发 indeterminate(只可能发 clear)", () => {
    enableProgressGate();
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Idle} titleHint="x" />,
    );
    const out = stdout.get();
    expect(out).not.toContain(`${OSC94}3;`);
    unmount();
  });

  test("卸载时发 clear(;0;)清进度环", () => {
    enableProgressGate();
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Responding} titleHint="x" />,
    );
    unmount();
    // ESC]9;4;0; → state=0=clear
    expect(stdout.get()).toContain(`${OSC94}0;`);
  });

  test("gate 不可用(非 TTY 默认)→ 完全不发 OSC 9;4", () => {
    // 不调 enableProgressGate:render harness stdout 非 TTY,
    // 但 isProgressReportingAvailable 读的是真实 process.stdout.isTTY。
    // 显式关掉以确保 gate=false。
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Responding} titleHint="x" />,
    );
    expect(stdout.get()).not.toContain(OSC94);
    unmount();
  });
});
