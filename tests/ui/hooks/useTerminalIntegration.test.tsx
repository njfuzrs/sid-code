/**
 * useTerminalIntegration 终端集成测试
 *
 * 验证真实写到终端 stdout 的字节链(用 vendored ink 的 render harness,
 * 它经 TerminalWriteContext 把 writeRaw 真实接到捕获的 stdout):
 * OSC 0 终端标题——进行中带动画点前缀、其余带静态星号,且含 titleHint。
 *
 * 这些断言不依赖"肉眼能否看到 tab",而是直接证明序列字节发出且内容正确。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import { useTerminalIntegration } from "@sid-code/cli/ui/hooks/useTerminalIntegration.ts";
import { StreamingState } from "@sid-code/cli/ui/types.ts";
import { TITLE_STATIC_PREFIX, TITLE_ANIMATION_FRAMES } from "@sid-code/cli/ui/constants/figures.ts";

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

  test("连接中(等首字)同样带动画点前缀——标题在连接期就跳动", () => {
    // Connecting 与 Responding 都属「活动中」,标题动画前缀从回车那刻起就跑,
    // 不等首字到达。这是消灭首字延迟盲区在终端标题上的体现。
    const { stdout, unmount } = render(
      <Harness streamingState={StreamingState.Connecting} titleHint="连接任务" />,
    );
    const out = stdout.get();
    expect(out).toContain(`${OSC2}${TITLE_ANIMATION_FRAMES[0]} 连接任务\x07`);
    expect(out).toContain(`${OSC0}${TITLE_ANIMATION_FRAMES[0]} 连接任务\x07`);
    unmount();
  });
});
