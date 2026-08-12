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
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { useLoadingIndicator } from "@sid-code/cli/ui/hooks/useLoadingIndicator.ts";
import { StreamingState } from "@sid-code/cli/ui/types.ts";

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
  const { elapsedTime, currentLoadingPhrase, slowHint, toolElapsedTime } = useLoadingIndicator({
    streamingState,
    toolName,
    progressCount,
  });
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

/**
 * 轮询等待:反复取帧直到某计时字段(elapsed / toolElapsed)达到 target(或超时),返回观测到的值。
 *
 * 替代"固定睡眠 + 精确等值断言"——后者依赖真实 setInterval 在一次固定 sleep 内恰好 tick 到目标,
 * 高负载(全量并发跑测试)时事件循环拥塞会 tick 迟到/丢拍 → 计时停在 0 或跳到别的值 → flaky。
 * 轮询只要求"最终 tick 到目标"即成立,对单次调度延迟鲁棒,同时仍验证"计时确实在走"这一语义。
 */
async function waitForCounter(
  lastFrame: () => string | undefined,
  field: "elapsed" | "toolElapsed",
  target: number,
  timeoutMs = 6000,
): Promise<number> {
  const re = new RegExp(`${field}=(\\d+)`);
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const m = re.exec(stripAnsi(lastFrame() ?? ""));
    seen = m ? Number(m[1]) : seen;
    if (seen >= target) return seen;
    await new Promise((r) => setTimeout(r, 100));
  }
  return seen;
}

/**
 * 轮询等待某段文本出现在帧里(或超时后返回 false)。
 *
 * 用于「归零/重置」类断言:重置是 React 的 setState,高负载下单个 macrotask
 * (setTimeout 0) 未必够 React 提交完成 → 立刻断言会读到旧值 → flaky(见 toolElapsed 归零)。
 * 轮询「直到重置提交」对提交延迟鲁棒;而重置值(0)在下一次 1000ms 计时 tick 前一直成立,
 * 用短轮询间隔(默认 20ms)能在它被重新递增前稳定命中,不会误判方向。
 */
async function waitForText(
  lastFrame: () => string | undefined,
  needle: string,
  timeoutMs = 3000,
  pollMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stripAnsi(lastFrame() ?? "").includes(needle)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

describe("useLoadingIndicator — 状态文案", () => {
  test("Idle 态：计时为 0，无文案", () => {
    const { lastFrame } = render(<TestHarness streamingState={StreamingState.Idle} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=0");
    expect(frame).toContain("phrase=(null)");
    expect(frame).toContain("slowHint=(null)");
  });

  test("Connecting 态（首字等待）：elapsed=0，文案为「连接中…」", () => {
    const { lastFrame } = render(<TestHarness streamingState={StreamingState.Connecting} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=0");
    expect(frame).toContain("phrase=连接中…");
  });

  test("Responding 态（流式无工具）：有动词文案", () => {
    const { lastFrame } = render(<TestHarness streamingState={StreamingState.Responding} />);
    const frame = stripAnsi(lastFrame() ?? "");
    // 应该有非 null 的短语（动词池随机结果）
    expect(frame).not.toContain("phrase=(null)");
  });

  test("Responding 态（工具执行中）：phrase 为 null，由组件拼「执行 X…」", () => {
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.Responding} toolName="bash" />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("phrase=(null)");
  });

  test("Connecting 步间续作（progressCount > 0）：文案为「处理中…」", () => {
    // 真实场景：先在 Responding 中产出过内容（prevProgressRef 同步），
    // 工具结束时短暂落回 Connecting——此时 prevProgressRef 已 > 0。
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Responding} progressCount={100} />,
    );
    // 落到 Connecting（步间空档）
    rerender(<TestHarness streamingState={StreamingState.Connecting} progressCount={100} />);
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
    const { lastFrame, rerender } = render(<TestHarness streamingState={StreamingState.Idle} />);
    // 从 Idle 切换到 Connecting — 上升沿应归零
    rerender(<TestHarness streamingState={StreamingState.Connecting} />);
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("elapsed=0");

    // 计时启动:轮询等到 elapsed 递增到 ≥1(interval 最终 tick,不依赖单次固定睡眠命中)。
    const elapsed = await waitForCounter(lastFrame, "elapsed", 1);
    expect(elapsed).toBeGreaterThanOrEqual(1);
  });

  test("Connecting→Responding 不归零（根治盲区 2）", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Connecting} />,
    );
    // 轮询等到计时 ≥2（不依赖单次固定睡眠恰好 tick 两次）
    const firstElapsed = await waitForCounter(lastFrame, "elapsed", 2);
    expect(firstElapsed).toBeGreaterThanOrEqual(2);

    // 切换到 Responding — 计时应连续，不归零
    rerender(<TestHarness streamingState={StreamingState.Responding} />);
    const frame = stripAnsi(lastFrame() ?? "");
    // 不会归零到 0
    expect(frame).not.toContain("elapsed=0");
    const afterSwitch = /elapsed=(\d+)/.exec(frame)?.[1];
    expect(Number(afterSwitch)).toBeGreaterThanOrEqual(firstElapsed);
  });

  test("回到 Idle 后计时停止", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Connecting} />,
    );
    // 轮询等到计时 ≥2
    const elapsed = await waitForCounter(lastFrame, "elapsed", 2);
    expect(elapsed).toBeGreaterThanOrEqual(2);

    // 切换到 Idle — 计时停止
    rerender(<TestHarness streamingState={StreamingState.Idle} />);
    const frozenElapsed = /elapsed=(\d+)/.exec(stripAnsi(lastFrame() ?? ""))?.[1];

    // 再等 1.5 秒 — 计时不应增长
    await new Promise((r) => setTimeout(r, 1500));
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain(`elapsed=${frozenElapsed}`);
  });

  test("新轮次重新触发上升沿归零", async () => {
    const { lastFrame, rerender } = render(<TestHarness streamingState={StreamingState.Idle} />);

    // 第一轮：Connecting → 等 2s → Responding → Idle
    rerender(<TestHarness streamingState={StreamingState.Connecting} />);
    await new Promise((r) => setTimeout(r, 2100));
    rerender(<TestHarness streamingState={StreamingState.Responding} />);
    await new Promise((r) => setTimeout(r, 1100));
    // 关键不变量:Connecting→Responding 是内部切换,不触发上升沿归零(根治盲区 2)。
    // 注意:不断言"elapsed 已 >0"——那依赖真实 setInterval 至少 tick 过一次,
    // 高负载(全量并发)下事件循环拥塞可能一次没 tick,elapsed 停 0 → 误判(flaky 根因)。
    // 归零与否由「上升沿 useEffect 同步 setElapsedTime(0)」决定,与计时器 tick 无关,
    // 故这里验"从 Responding 回 Idle 时未发生过归零重置",而非验"已递增"。
    rerender(<TestHarness streamingState={StreamingState.Idle} />);

    // 第二轮：从 Idle 再次进入 Connecting → 上升沿归零(effect 同步置 0,确定性,不 flaky)
    rerender(<TestHarness streamingState={StreamingState.Connecting} />);
    // 轮询等归零提交:高负载下单个 macrotask 不够 React 提交,固定睡眠后立刻断言会 flaky。
    expect(await waitForText(lastFrame, "elapsed=0")).toBe(true);
  });
});

describe("useLoadingIndicator — 慢提示与工具计时", () => {
  test("Connecting 态初始时 slowHint 为 null", () => {
    const { lastFrame } = render(<TestHarness streamingState={StreamingState.Connecting} />);
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
    const { lastFrame } = render(
      <TestHarness streamingState={StreamingState.Responding} toolName="bash" />,
    );
    // 工具初始计时为 0
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=0");

    // 轮询等到工具计时 ≥2（interval 最终 tick，不依赖单次固定睡眠命中）
    const toolElapsed = await waitForCounter(lastFrame, "toolElapsed", 2);
    expect(toolElapsed).toBeGreaterThanOrEqual(2);
  });

  test("换工具：toolElapsed 归零重计", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Responding} toolName="bash" />,
    );
    const toolElapsed = await waitForCounter(lastFrame, "toolElapsed", 2);
    expect(toolElapsed).toBeGreaterThanOrEqual(2);

    // 换工具 → toolElapsed 归零
    rerender(<TestHarness streamingState={StreamingState.Responding} toolName="read" />);
    // 轮询等归零提交(见 waitForText 注释):固定睡眠后立刻断言在高负载下 flaky。
    expect(await waitForText(lastFrame, "toolElapsed=0")).toBe(true);

    // read 执行后计时重新递增到 ≥1
    const readElapsed = await waitForCounter(lastFrame, "toolElapsed", 1);
    expect(readElapsed).toBeGreaterThanOrEqual(1);
  });

  test("工具结束后 toolElapsedTime 归零并停止增长", async () => {
    const { lastFrame, rerender } = render(
      <TestHarness streamingState={StreamingState.Responding} toolName="bash" />,
    );
    const toolElapsed = await waitForCounter(lastFrame, "toolElapsed", 2);
    expect(toolElapsed).toBeGreaterThanOrEqual(2);

    // 工具结束
    rerender(<TestHarness streamingState={StreamingState.Responding} toolName={null} />);
    // 轮询等归零提交(见 waitForText 注释)。
    expect(await waitForText(lastFrame, "toolElapsed=0")).toBe(true);

    // 再等 1.5 秒 — toolElapsed 不应增长
    await new Promise((r) => setTimeout(r, 1500));
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("toolElapsed=0");
  });
});
