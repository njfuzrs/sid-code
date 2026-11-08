/**
 * 等待源进后台面板 —— TodoPanel `WK` 行（§5.7.3 / §9.2.1 T-T1-1/7/8/9）。
 *
 * 三条与普通任务行**语义不同**的地方，各自锁一条断言：
 * 1. 字形 `○` 空心且**不旋转**（「在等」不等于「在跑」）；
 * 2. 统计列是「HH:MM 触发 · 剩 Xm」，不是耗时；
 * 3. 没有终态行——到点注入即从面板消失（这条在 state-bridge 测试里锁）。
 *
 * 整帧渲染（不是纯函数断言）：这些缺陷纯函数单测全绿也照样存在，
 * 只有真渲染出帧才看得出（ui/CLAUDE.md L5.2）。
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import React from "react";
import chalk from "chalk";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { TodoPanel } from "@sid-code/cli/ui/components/TodoPanel.tsx";
import { AccessibilityProvider } from "@sid-code/cli/ui/accessibility/AccessibilityContext.tsx";
import type { TaskDisplayInfo } from "@sid-code/cli/ui/App.tsx";

// 测试环境默认 chalk.level=0（非 TTY 无色），颜色断言必须先强制开色，
// 否则「warning 色」这条即使实现正确也拿不到 ANSI 码（同 diff-ansi-lines.test.ts 的做法）。
const savedChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = savedChalkLevel;
});

const TERM_WIDTH = 100;
const NARROW_WIDTH = 59;

/** 一条挂在调度器里的定时唤醒（state-bridge 合成的形状） */
function wakeupTask(over: Partial<TaskDisplayInfo> = {}): TaskDisplayInfo {
  return {
    id: "w1",
    type: "wakeup",
    kind: "wakeup",
    status: "waiting",
    description: "检查 PR #662 的 CI 状态",
    startTime: Date.now(),
    durationMs: 0,
    dueAt: Date.now() + 8 * 60_000,
    ...over,
  };
}

function runningTask(over: Partial<TaskDisplayInfo> = {}): TaskDisplayInfo {
  return {
    id: "t1",
    type: "local_agent",
    status: "running",
    description: "跑测试",
    agentType: "explore",
    startTime: Date.now() - 10_000,
    durationMs: 1_000,
    ...over,
  };
}

function terminalTask(id = "d1"): TaskDisplayInfo {
  return {
    id,
    type: "local_agent",
    status: "completed",
    description: "已完成的任务",
    agentType: "explore",
    startTime: Date.now() - 60_000,
    endTime: Date.now(),
    durationMs: 60_000,
  };
}

function frameOf(tasks: TaskDisplayInfo[], width = TERM_WIDTH): string {
  const { lastFrame } = render(<TodoPanel todos={[]} tasks={tasks} termWidth={width} />);
  return stripAnsi(lastFrame() ?? "");
}

describe("TodoPanel — 定时唤醒行 WK（T-T1-1）", () => {
  test("出 `○ [WK] <prompt 首行>` 与「HH:MM 触发 · 剩 Xm」", () => {
    const frame = frameOf([wakeupTask()]);
    expect(frame).toContain("○");
    expect(frame).toContain("[WK]");
    expect(frame).toContain("检查 PR #662 的 CI 状态");
    // 「剩 Xm」的分钟数随墙钟走，用正则而非字面量
    expect(frame).toMatch(/\d{2}:\d{2} 触发 · 剩 \d+m/);
  });

  test("唤醒行不进「N 运行中」：它在等，没在跑", () => {
    const frame = frameOf([wakeupTask()]);
    expect(frame).not.toContain("运行中");
    expect(frame).toContain("1 等待中");
  });

  test("剩余 < 2 分钟时统计列转 warning 色（克制点睛，只点统计列）", () => {
    // 颜色断言走原始帧（stripAnsi 之后看不到色）：取含「触发」的那一行，确认带 ANSI 色码
    const { lastFrame } = render(
      <TodoPanel
        todos={[]}
        tasks={[wakeupTask({ dueAt: Date.now() + 30_000 })]}
        termWidth={TERM_WIDTH}
      />,
    );
    const raw = lastFrame() ?? "";
    const urgentLine = raw.split("\n").find((l) => l.includes("触发")) ?? "";
    expect(urgentLine).toMatch(/\x1b\[[0-9;]*m/); // 有颜色
    expect(stripAnsi(urgentLine)).toContain("剩 1m");
  });
});

describe("TodoPanel — 唤醒行的排序与上限（T-T1-7）", () => {
  test("排序：running → 唤醒 → 终态", () => {
    const frame = frameOf([terminalTask(), wakeupTask(), runningTask()]);
    const lines = frame.split("\n").map((l) => l.trimEnd());
    const runningIdx = lines.findIndex((l) => l.includes("[AG explore]"));
    const wakeupIdx = lines.findIndex((l) => l.includes("[WK]"));
    const terminalIdx = lines.findIndex((l) => l.includes("[AG explore]") && l.includes("●"));
    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(wakeupIdx).toBeGreaterThan(runningIdx);
    expect(terminalIdx).toBeGreaterThan(wakeupIdx);
  });

  test("唤醒行计入 5 行上限：4 个 running + 1 唤醒 = 5 行全显示", () => {
    const tasks = [
      runningTask({ id: "r1" }),
      runningTask({ id: "r2" }),
      runningTask({ id: "r3" }),
      runningTask({ id: "r4" }),
      wakeupTask(),
    ];
    const frame = frameOf(tasks);
    expect(frame).toContain("[WK]");
    expect(frame).not.toContain("…+1");
  });

  test("超过 5 行时唤醒行仍在窗口内，被挤掉的是终态", () => {
    const tasks = [
      runningTask({ id: "r1" }),
      runningTask({ id: "r2" }),
      runningTask({ id: "r3" }),
      runningTask({ id: "r4" }),
      wakeupTask(),
      terminalTask("d1"),
    ];
    const frame = frameOf(tasks);
    expect(frame).toContain("[WK]"); // 唤醒优先于终态进窗口
    expect(frame).toContain("…+1");
  });
});

describe("TodoPanel — 窄终端折叠文案（T-T1-8）", () => {
  test("按类型计数：`后台：1 shell · 1 唤醒`", () => {
    const shellTask: TaskDisplayInfo = {
      id: "s1",
      type: "local_shell",
      status: "running",
      description: "跑测试",
      command: "bun test",
      startTime: Date.now() - 5_000,
      durationMs: 1_000,
    };
    const frame = frameOf([shellTask, wakeupTask()], NARROW_WIDTH);
    expect(frame).toContain("后台：1 shell · 1 唤醒");
  });

  test("各类计数为 0 时省略（不写 `0 唤醒`）", () => {
    const frame = frameOf([runningTask()], NARROW_WIDTH);
    expect(frame).toContain("后台：1 agent");
    expect(frame).not.toContain("0 唤醒");
    expect(frame).not.toContain("0 shell");
  });
});

describe("TodoPanel — a11y 关动画（T-T1-9）", () => {
  test("a11y 下唤醒行仍是静态 ○，但「剩 Xm」继续显示（数字不是动画）", () => {
    const { lastFrame } = render(
      <AccessibilityProvider initialEnabled={true}>
        <TodoPanel todos={[]} tasks={[wakeupTask()]} termWidth={TERM_WIDTH} />
      </AccessibilityProvider>,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("○");
    expect(frame).toMatch(/剩 \d+m/);
    // 唤醒行从不旋转：a11y 开关前后都不该出现 ◐ 的其它三象限
    expect(frame).not.toMatch(/[◓◑◒]/);
  });
});
