/**
 * useLoadingIndicator Hook 测试
 *
 * 用 vendored ink 的 render harness + bun fake timer 驱动 hook 的 setInterval，
 * 通过一个极简 Harness 组件把 hook 返回值渲染成可断言的字节，确定性验证：
 * 1. Connecting 态计时启动并随时间递增。
 * 2. Connecting→Responding 不归零（根治盲区 2 的回归保护）。
 * 3. Idle→Connecting 上升沿归零。
 * 4. Connecting 文案为「连接中…」。
 * 5. 回到 Idle 计时停止。
 * 6. 慢提示按【静默时长】出现——零产出累积才报；token 在流则永不报（核心回归）。
 */

import { test, expect, describe, afterEach, jest } from "bun:test";
import React from "react";
import { render } from "../../../src/ink/_vendor/testing.tsx";
import { useLoadingIndicator } from "../../../src/ui/hooks/useLoadingIndicator.ts";
import { StreamingState } from "../../../src/ui/types.ts";
import { SLOW_RESPONSE_HINTS } from "../../../src/ui/constants/loading-phrases.ts";
import Text from "../../../src/ink/components/Text.js";

/** 极简宿主：把 hook 返回值渲染成 `E<秒>|<文案>|<慢提示>` 便于字节断言。 */
function Harness({
  s,
  outputTokens = 0,
}: {
  s: StreamingState;
  outputTokens?: number;
}): React.ReactElement {
  const { elapsedTime, currentLoadingPhrase, slowHint } = useLoadingIndicator({
    streamingState: s,
    toolName: null,
    outputTokens,
  });
  return React.createElement(
    Text,
    null,
    `E${elapsedTime}|${currentLoadingPhrase ?? "null"}|${slowHint ?? "null"}`,
  );
}

/** 工具级计时 Harness：渲染 `T<工具秒>`，可切换 toolName。 */
function ToolHarness({
  s,
  toolName,
}: {
  s: StreamingState;
  toolName: string | null;
}): React.ReactElement {
  const { toolElapsedTime } = useLoadingIndicator({ streamingState: s, toolName });
  return React.createElement(Text, null, `T${toolElapsedTime}`);
}

/** 从工具 Harness 帧解析工具级秒数。 */
function parseToolElapsed(frame: string | undefined): number {
  const m = (frame ?? "").match(/T(\d+)/);
  return m ? Number(m[1]) : NaN;
}

/** 从帧里解析出 elapsedTime 数字（E 后到第一个 | 之间）。 */
function parseElapsed(frame: string | undefined): number {
  const m = (frame ?? "").match(/E(\d+)\|/);
  return m ? Number(m[1]) : NaN;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("useLoadingIndicator", () => {
  test("Connecting 态计时启动并随时间递增", () => {
    jest.useFakeTimers();
    const { lastFrame, rerender } = render(<Harness s={StreamingState.Connecting} />);
    expect(parseElapsed(lastFrame())).toBe(0);
    jest.advanceTimersByTime(3000);
    rerender(<Harness s={StreamingState.Connecting} />);
    expect(parseElapsed(lastFrame())).toBe(3);
  });

  test("Connecting→Responding 不归零（根治盲区 2）", () => {
    jest.useFakeTimers();
    const { lastFrame, rerender } = render(<Harness s={StreamingState.Connecting} />);
    jest.advanceTimersByTime(5000);
    rerender(<Harness s={StreamingState.Connecting} />);
    expect(parseElapsed(lastFrame())).toBe(5);
    // 首字到达：切到 Responding，计时必须延续而非重置为 0。
    rerender(<Harness s={StreamingState.Responding} />);
    jest.advanceTimersByTime(0);
    rerender(<Harness s={StreamingState.Responding} />);
    expect(parseElapsed(lastFrame())).toBe(5);
    // 继续走，从 5 累加而非从 0。
    jest.advanceTimersByTime(2000);
    rerender(<Harness s={StreamingState.Responding} />);
    expect(parseElapsed(lastFrame())).toBe(7);
  });

  test("Idle→Connecting 上升沿归零", () => {
    jest.useFakeTimers();
    const { lastFrame, rerender } = render(<Harness s={StreamingState.Connecting} />);
    jest.advanceTimersByTime(4000);
    rerender(<Harness s={StreamingState.Connecting} />);
    expect(parseElapsed(lastFrame())).toBe(4);
    // 回到 Idle 再进 Connecting，应重新从 0 计。
    rerender(<Harness s={StreamingState.Idle} />);
    jest.advanceTimersByTime(0);
    rerender(<Harness s={StreamingState.Idle} />);
    rerender(<Harness s={StreamingState.Connecting} />);
    jest.advanceTimersByTime(0);
    rerender(<Harness s={StreamingState.Connecting} />);
    expect(parseElapsed(lastFrame())).toBe(0);
  });

  test("Connecting 文案为「连接中…」", () => {
    jest.useFakeTimers();
    const { lastFrame } = render(<Harness s={StreamingState.Connecting} />);
    expect(lastFrame() ?? "").toContain("连接中…");
  });

  test("回到 Idle 计时停止", () => {
    jest.useFakeTimers();
    const { lastFrame, rerender } = render(<Harness s={StreamingState.Responding} />);
    jest.advanceTimersByTime(3000);
    rerender(<Harness s={StreamingState.Responding} />);
    expect(parseElapsed(lastFrame())).toBe(3);
    rerender(<Harness s={StreamingState.Idle} />);
    jest.advanceTimersByTime(5000);
    rerender(<Harness s={StreamingState.Idle} />);
    // Idle 后计时不再增长（停在切换前的值或被组件 Idle 分支接管，关键是不递增）。
    const after = parseElapsed(lastFrame());
    expect(after).toBe(3);
  });

  test("慢提示按【静默时长】出现：零产出累积到首阈值才报", () => {
    jest.useFakeTimers();
    const first = SLOW_RESPONSE_HINTS[0];
    // outputTokens 恒为 0（从不产出）→ 静默时长 == 经过时长。
    const { lastFrame, rerender } = render(<Harness s={StreamingState.Connecting} />);
    // 未达首阈值前：无慢提示。
    jest.advanceTimersByTime((first.thresholdSec - 1) * 1000);
    rerender(<Harness s={StreamingState.Connecting} />);
    expect(lastFrame() ?? "").toContain("|null"); // slowHint 段为 null
    // 跨过首阈值：出现第一档文案。
    jest.advanceTimersByTime(2000);
    rerender(<Harness s={StreamingState.Connecting} />);
    expect(lastFrame() ?? "").toContain(first.hint);
  });

  test("核心回归：token 持续产出时，整轮再久也不报慢", () => {
    jest.useFakeTimers();
    const first = SLOW_RESPONSE_HINTS[0];
    let tokens = 0;
    // 模拟模型在正常流式输出：每秒产出 token，整轮跑很久（远超慢提示阈值）。
    // 这正是 bug 现场——旧逻辑用整轮 elapsedTime 判定，此时会误报「响应较慢/卡住」；
    // 新逻辑用静默时长，token 一直在涨 → 静默归零 → 绝不报慢。
    const { lastFrame, rerender } = render(
      <Harness s={StreamingState.Responding} outputTokens={tokens} />,
    );
    const farPastThreshold = (first.thresholdSec + 30) * 1000;
    const stepMs = 1000;
    for (let elapsed = 0; elapsed < farPastThreshold; elapsed += stepMs) {
      jest.advanceTimersByTime(stepMs);
      tokens += 50; // 每秒都有新产出
      rerender(<Harness s={StreamingState.Responding} outputTokens={tokens} />);
    }
    // 整轮已远超阈值，但因 token 持续在流，慢提示始终为 null。
    expect(lastFrame() ?? "").toContain("|null");
    expect(lastFrame() ?? "").not.toContain(first.hint);
  });

  test("token 停止产出后，静默累积到阈值才报慢", () => {
    jest.useFakeTimers();
    const first = SLOW_RESPONSE_HINTS[0];
    // 先正常产出几秒（不报慢），然后 token 冻结，开始累积静默。
    const { lastFrame, rerender } = render(
      <Harness s={StreamingState.Responding} outputTokens={100} />,
    );
    jest.advanceTimersByTime(5000);
    rerender(<Harness s={StreamingState.Responding} outputTokens={300} />); // 还在产出
    expect(lastFrame() ?? "").toContain("|null");
    // token 冻结在 300，静默开始累积；跨过首阈值后报慢。
    jest.advanceTimersByTime((first.thresholdSec + 1) * 1000);
    rerender(<Harness s={StreamingState.Responding} outputTokens={300} />);
    expect(lastFrame() ?? "").toContain(first.hint);
  });
});

describe("useLoadingIndicator — L3 工具级计时", () => {
  test("toolName 非空时工具计时递增", () => {
    jest.useFakeTimers();
    const { lastFrame, rerender } = render(
      <ToolHarness s={StreamingState.Responding} toolName="bash" />,
    );
    expect(parseToolElapsed(lastFrame())).toBe(0);
    jest.advanceTimersByTime(4000);
    rerender(<ToolHarness s={StreamingState.Responding} toolName="bash" />);
    expect(parseToolElapsed(lastFrame())).toBe(4);
  });

  test("换工具即归零重计（不累加上一个工具的耗时）", () => {
    jest.useFakeTimers();
    const { lastFrame, rerender } = render(
      <ToolHarness s={StreamingState.Responding} toolName="bash" />,
    );
    jest.advanceTimersByTime(8000);
    rerender(<ToolHarness s={StreamingState.Responding} toolName="bash" />);
    expect(parseToolElapsed(lastFrame())).toBe(8);
    // 切到另一个工具 → 归零。
    rerender(<ToolHarness s={StreamingState.Responding} toolName="read" />);
    jest.advanceTimersByTime(0);
    rerender(<ToolHarness s={StreamingState.Responding} toolName="read" />);
    expect(parseToolElapsed(lastFrame())).toBe(0);
    jest.advanceTimersByTime(2000);
    rerender(<ToolHarness s={StreamingState.Responding} toolName="read" />);
    expect(parseToolElapsed(lastFrame())).toBe(2);
  });

  test("工具结束（toolName 清空）后工具计时归零", () => {
    jest.useFakeTimers();
    const { lastFrame, rerender } = render(
      <ToolHarness s={StreamingState.Responding} toolName="bash" />,
    );
    jest.advanceTimersByTime(5000);
    rerender(<ToolHarness s={StreamingState.Responding} toolName="bash" />);
    expect(parseToolElapsed(lastFrame())).toBe(5);
    // 工具结束，回到纯文本流式（无工具）。
    rerender(<ToolHarness s={StreamingState.Responding} toolName={null} />);
    jest.advanceTimersByTime(0);
    rerender(<ToolHarness s={StreamingState.Responding} toolName={null} />);
    expect(parseToolElapsed(lastFrame())).toBe(0);
  });
});
