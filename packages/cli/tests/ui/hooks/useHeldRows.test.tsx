/**
 * 瞬态行占位的释放时机（hooks/useHeldRows.ts）。
 *
 * 回归背景（2026-11-04 用户截图）：#559 让瞬态行「出现过就占到下一轮开始」，
 * 回合中途出现过一次的 Toast / 状态提示以空行形式挂到回合结束；它在 gap={1} 的留白区里
 * 一行空占位 = 2 行空白，「思考中」与 spinner 之间出现 3 行空白。
 * 修法：历史区新增一项（epoch 变化）时也放掉；全屏布局不占位。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import {
  HeldRowsContext,
  nextHeldRows,
  useHeldRows,
  type HeldRowsPolicy,
  type HeldRowsState,
} from "@sid-code/cli/ui/hooks/useHeldRows.ts";

const MAIN = (epoch: number): HeldRowsPolicy => ({ enabled: true, epoch });

describe("nextHeldRows：释放时机", () => {
  const fresh = (): HeldRowsState => ({ held: 0, prevBusy: true, prevEpoch: 0 });

  test("回合中消失的行被占住（不让主屏帧变矮）", () => {
    const s = fresh();
    expect(nextHeldRows(s, 1, true, MAIN(0))).toBe(1);
    expect(nextHeldRows(s, 0, true, MAIN(0))).toBe(1);
  });

  test("历史新增一项时放掉（回归：曾占到回合结束）", () => {
    const s = fresh();
    nextHeldRows(s, 1, true, MAIN(0));
    nextHeldRows(s, 0, true, MAIN(0));
    expect(nextHeldRows(s, 0, true, MAIN(1))).toBe(0);
  });

  test("下一轮开始（busy 上升沿）时放掉", () => {
    const s = fresh();
    nextHeldRows(s, 1, true, MAIN(0));
    nextHeldRows(s, 0, false, MAIN(0));
    expect(nextHeldRows(s, 0, true, MAIN(0))).toBe(0);
  });

  // 2026-11-05 用户截图：空闲时 Ctrl+O 提示消失后，最后一条消息与输入框之间挂着 2 行空白到下一轮
  test("releaseWhenIdle：空闲时提示消失即放掉", () => {
    const s: HeldRowsState = { held: 0, prevBusy: false, prevEpoch: 0 };
    const idle = { releaseWhenIdle: true };
    expect(nextHeldRows(s, 1, false, MAIN(0), idle)).toBe(1);
    expect(nextHeldRows(s, 0, false, MAIN(0), idle)).toBe(0);
  });

  test("releaseWhenIdle：回合中仍占住（不放宽高频零重画）", () => {
    const s = fresh();
    const idle = { releaseWhenIdle: true };
    nextHeldRows(s, 1, true, MAIN(0), idle);
    expect(nextHeldRows(s, 0, true, MAIN(0), idle)).toBe(1);
  });

  test("不传 releaseWhenIdle：空闲时照旧占住（输入框 / 退出警告）", () => {
    const s: HeldRowsState = { held: 0, prevBusy: false, prevEpoch: 0 };
    nextHeldRows(s, 1, false, MAIN(0));
    expect(nextHeldRows(s, 0, false, MAIN(0))).toBe(1);
  });

  test("全屏布局不占位", () => {
    const s = fresh();
    const off = { enabled: false, epoch: 0 };
    nextHeldRows(s, 1, true, off);
    expect(nextHeldRows(s, 0, true, off)).toBe(0);
  });
});

/** 整帧：占住时多一行空白，epoch 变了这行就没了 */
const Row: React.FC<{ show: boolean }> = ({ show }) => {
  const rows = useHeldRows(show ? 1 : 0, true);
  if (rows === 0) return null;
  return <Box minHeight={rows}>{show ? <Text>提示</Text> : null}</Box>;
};
const Frame: React.FC<{ show: boolean; epoch: number }> = ({ show, epoch }) => (
  <HeldRowsContext.Provider value={MAIN(epoch)}>
    <Box flexDirection="column" gap={1}>
      <Text>上</Text>
      <Row show={show} />
      <Text>下</Text>
    </Box>
  </HeldRowsContext.Provider>
);
const lines = (f: string | undefined) => stripAnsi(f ?? "").split("\n").length;

test("整帧：提示消失后占住，历史新增后空白收回", async () => {
  const r = render(<Frame show epoch={0} />);
  const withHint = lines(r.lastFrame());
  r.rerender(<Frame show={false} epoch={0} />);
  expect(lines(r.lastFrame())).toBe(withHint);
  r.rerender(<Frame show={false} epoch={1} />);
  // 少掉占位行 + 它带来的那 1 行 gap
  expect(lines(r.lastFrame())).toBe(withHint - 2);
  r.unmount();
});
