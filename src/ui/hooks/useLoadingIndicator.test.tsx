/**
 * useLoadingIndicator Hook 单测 — §6.1
 *
 * 验证计时器生命周期与状态文案：
 * 1. Connecting 态计时启动 — elapsedTime 随时间递增
 * 2. Connecting→Responding 不归零 — 计时连续
 * 3. Idle→Connecting 上升沿归零 — 新轮开始计时重置
 * 4. Connecting 文案 — currentLoadingPhrase === "连接中…"
 * 5. 回到 Idle 计时停止 — elapsedTime 不再增长
 * 6. Connecting 步间续作文案 — 本轮已产出内容时显示 "处理中…"
 *
 * 计时器测试使用真实 setTimeout（异步），避免 fake timers 与 vendored ink
 * render 的 React 调度不兼容问题。慢提示阈值纯逻辑由 loading-phrases.test.ts 覆盖。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "../../ink/_vendor/testing.js";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useLoadingIndicator } from "./useLoadingIndicator.ts";
import { StreamingState } from "../types.ts";

/** 测试附着组件：调用 useLoadingIndicator 并把返回值渲染为文本 */
function TestHarness({
  streamingState,
  toolName = null,
  progressCount = 0,
}: {
  streamingState: StreamingState;
  toolName?: string | null;
  progressCount?: number;
}) {
  const { elapsedTime, currentLoadingPhrase, slowHint, toolElapsedTime } =
    useLoadingIndicator({ streamingState, toolName, progressCount });
  return (
    <Box flexDirection="column">
      <Text>elapsed={elapsedTime}</Text>
      <Text>phrase={currentLoadingPhrase ?? "(null)"}</Text>
      <Text>slowHint={slowHint ?? "(null)"}</Text>
      <Text>toolElapsed={toolElapsedTime}</Text>
    </Box>
  );
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("useLoadingIndicator — 状态文案", () => {
  test("Idle 态：计时为 0，无文案", () => {
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.Idle} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=0");
    expect(frame).toContain("phrase=(null)");
    expect(frame).toContain("slowHint=(null)");
  });

  test("Connecting 态（首字等待）：elapsed=0，文案为「连接中…」", () => {
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.Connecting} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=0");
    expect(frame).toContain("phrase=连接中…");
  });

  test("Responding 态（流式无工具）：有动词文案", () => {
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.Responding} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // 应该有非 null 的短语（动词池随机结果）
    expect(frame).not.toContain("phrase=(null)");
  });

  test("Responding 态（工具执行中）：phrase 为 null，由组件拼「执行 X…」", () => {
    const { lastFrame } = render(
      <TestHarness
        streamingState={StreamingState.Responding}
        toolName="bash"
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("phrase=(null)");
  });

  test("Connecting 步间续作（progressCount > 0）：文案为「处理中…」", () => {
    // 真实场景：先在 Responding 中产出过内容（prevProgressRef 同步），
    // 工具结束时短暂落回 Connecting——此时 prevProgressRef 已 > 0。
    const { lastFrame, rerender } = render(
      <TestHarness
        streamingState={StreamingState.Responding}
        progressCount={100}
      />,
    );
    // 落到 Connecting（步间空档）
    rerender(
      <TestHarness
        streamingState={StreamingState.Connecting}
        progressCount={100}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("phrase=处理中…");
  });

  test("WaitingForConfirmation 态：phrase 为 null", () => {
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.WaitingForConfirmation} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("phrase=(null)");
  });
});

describe("useLoadingIndicator — 计时器生命周期（异步真实计时器）", () => {
  test("Idle→Connecting 上升沿：计时归零并从 0 开始递增", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Idle} />,
    );
    // 从 Idle 切换到 Connecting — 上升沿应归零
    rerender(<TestHarness streamingState={StreamingState.Connecting} />);
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=0");

    // 等待 1.1 秒（给 setInterval 一个 tick 的空间）
    await new Promise(r => setTimeout(r, 1100));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=1");
  });

  test("Connecting→Responding 不归零（根治盲区 2）", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Connecting} />,
    );
    // 在 Connecting 等待约 2 秒
    await new Promise(r => setTimeout(r, 2100));
    let frame = stripAnsi(lastFrame() ?? "");
    const firstElapsed = /elapsed=(\d+)/.exec(frame)?.[1];
    // 计时应该 ≥ 2
    expect(Number(firstElapsed)).toBeGreaterThanOrEqual(2);

    // 切换到 Responding — 计时应连续，不归零
    rerender(<TestHarness streamingState={StreamingState.Responding} />);
    frame = stripAnsi(lastFrame() ?? "");
    // 不会归零到 0
    expect(frame).not.toContain("elapsed=0");
    const afterSwitch = /elapsed=(\d+)/.exec(frame)?.[1];
    expect(Number(afterSwitch)).toBeGreaterThanOrEqual(2);
  });

  test("回到 Idle 后计时停止", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Connecting} />,
    );
    // 等待约 2 秒
    await new Promise(r => setTimeout(r, 2100));
    let frame = stripAnsi(lastFrame() ?? "");
    const elapsed = /elapsed=(\d+)/.exec(frame)?.[1];
    expect(Number(elapsed)).toBeGreaterThanOrEqual(2);

    // 切换到 Idle — 计时停止
    rerender(<TestHarness streamingState={StreamingState.Idle} />);
    const frozenElapsed = /elapsed=(\d+)/.exec(stripAnsi(lastFrame() ?? ""))?.[1];

    // 再等 1.5 秒 — 计时不应增长
    await new Promise(r => setTimeout(r, 1500));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain(`elapsed=${frozenElapsed}`);
  });

  test("新轮次重新触发上升沿归零", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Idle} />,
    );

    // 第一轮：Connecting → 等 2s → Responding → Idle
    rerender(<TestHarness streamingState={StreamingState.Connecting} />);
    await new Promise(r => setTimeout(r, 2100));
    rerender(<TestHarness streamingState={StreamingState.Responding} />);
    await new Promise(r => setTimeout(r, 1100));
    rerender(<TestHarness streamingState={StreamingState.Idle} />);
    let frame = stripAnsi(lastFrame() ?? "");
    // 整轮约 3s，计时应 > 0 且不会归零
    expect(frame).not.toContain("elapsed=0");

    // 第二轮：从 Idle 再次进入 Connecting → 计时应归零
    rerender(<TestHarness streamingState={StreamingState.Connecting} />);
    // 等一个微任务让 React 处理 useEffect 中的 setState
    await new Promise(r => setTimeout(r, 0));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=0");
  });
});

describe("useLoadingIndicator — 慢提示与工具计时", () => {
  test("Connecting 态初始时 slowHint 为 null", () => {
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.Connecting} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("slowHint=(null)");
  });

  test("流式有产出时 slowHint 为 null（静默归零逻辑）", () => {
    // 在 Responding 态有产出 → 静默一直归零 → slowHint 为 null
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.Responding} progressCount={50} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("slowHint=(null)");
  });

  test("工具执行期间：toolElapsedTime 从 0 开始独立计时", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness
        streamingState={StreamingState.Responding}
        toolName="bash"
      />,
    );
    // 工具初始计时为 0
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=0");

    // 执行 2 秒
    await new Promise(r => setTimeout(r, 2100));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=2");
  });

  test("换工具：toolElapsed 归零重计", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness
        streamingState={StreamingState.Responding}
        toolName="bash"
      />,
    );
    await new Promise(r => setTimeout(r, 2100));
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=2");

    // 换工具 → toolElapsed 归零
    rerender(
      <TestHarness
        streamingState={StreamingState.Responding}
        toolName="read"
      />,
    );
    // 等 React 处理 useEffect 中的 setState
    await new Promise(r => setTimeout(r, 0));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=0");

    // read 执行 1 秒
    await new Promise(r => setTimeout(r, 1100));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=1");
  });

  test("工具结束后 toolElapsedTime 归零并停止增长", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness
        streamingState={StreamingState.Responding}
        toolName="bash"
      />,
    );
    await new Promise(r => setTimeout(r, 2100));
    let frame = stripAnsi(lastFrame() ?? "");
    const toolElapsed = /toolElapsed=(\d+)/.exec(frame)?.[1];
    expect(Number(toolElapsed)).toBeGreaterThanOrEqual(2);

    // 工具结束
    rerender(<TestHarness streamingState={StreamingState.Responding} toolName={null} />);
    // 等 React 处理 useEffect 中的 setState
    await new Promise(r => setTimeout(r, 0));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=0");

    // 再等 1.5 秒 — toolElapsed 不应增长
    await new Promise(r => setTimeout(r, 1500));
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=0");
  });
});
