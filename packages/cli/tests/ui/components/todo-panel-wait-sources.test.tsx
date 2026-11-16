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
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
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

/**
 * monitor 行的 `Ctrl+O` 展开（§5.7 面板表格第 3 行：「`⏎` 活动行 | 默认无；
 * `Ctrl+O` 展开显示脚本首行」）。
 *
 * 与「面板不显示最新事件」是同一处设计的两个面：**展开的是脚本**（回答「它在盯什么」），
 * 不是事件（那会与消息流重复，§5.7.2 去重原则）。所以两条断言必须成对：
 * 展开后出现 `command`，且**不出现**任何事件正文。
 */
function monitorTask(over: Partial<TaskDisplayInfo> = {}): TaskDisplayInfo {
  return {
    id: "m1",
    type: "local_monitor",
    kind: "monitor",
    status: "running",
    description: "PR #662 CI",
    command: "while true; do gh pr checks 662; sleep 45; done",
    startTime: Date.now() - 30_000,
    durationMs: 30_000,
    deadlineAt: Date.now() + 25 * 60_000,
    eventCount: 3,
    ...over,
  };
}

function frameWithExpand(
  tasks: TaskDisplayInfo[],
  expandLevel: 0 | 1 | 2,
  width = TERM_WIDTH,
): string {
  const { lastFrame } = render(
    <UIStateProvider initialExpandLevel={expandLevel}>
      <TodoPanel todos={[]} tasks={tasks} termWidth={width} />
    </UIStateProvider>,
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("TodoPanel — monitor 行 Ctrl+O 展开脚本首行（§5.7）", () => {
  test("默认（level 0）不显示脚本，也不显示事件内容", () => {
    const frame = frameWithExpand([monitorTask()], 0);
    expect(frame).toContain("[MO]");
    expect(frame).toContain("3 事件");
    // 默认态两个都不出现：脚本是待展开内容，事件是永不进面板
    expect(frame).not.toContain("while true");
    expect(frame).not.toContain("gh pr checks 662");
  });

  test("level 1 展开显示脚本首行（⎿ 缩进）", () => {
    const frame = frameWithExpand([monitorTask()], 1);
    // 脚本首行出现，且走统一的树枝前缀
    expect(frame).toContain("while true; do gh pr checks 662");
    expect(frame).toContain("⎿");
  });

  /**
   * 去重主断言的反向守护：即使展开，也只多出**脚本**这一行。
   * 若有人把「展开」实现成「显示最新事件」，这条立刻红。
   */
  test("展开后仍不出现事件正文（展开的是脚本，不是事件）", () => {
    const frame = frameWithExpand([monitorTask()], 2);
    expect(frame).toContain("while true");
    // 事件正文的典型形态（`⏺ 描述 · 事件首行`）不该出现在面板里
    expect(frame).not.toMatch(/·\s*(pass|fail|pending)/);
  });

  test("没有 command 的 monitor 行展开时不崩、不多出一行", () => {
    const frame = frameWithExpand([monitorTask({ command: undefined })], 1);
    expect(frame).toContain("[MO]");
    expect(frame).not.toContain("⎿");
  });
});

/**
 * T-T1-11：**无等待源时既有布局逐字节不变**。
 *
 * 这条防的是「为了插一行唤醒，把 shell / agent 行的列位置挤歪了」——纯函数断言
 * （「有无等待源时列表长度差 1」）全绿也照样存在，只有整帧逐字符对比才看得见
 * （ui/CLAUDE.md L5.2：涉及对齐/列宽一律整帧渲染）。
 *
 * 之前只有 `Footer.tsx` 的一句注释承诺「保证默认布局逐字节不变」，没有断言 ——
 * 注释不产生任何约束（本仓有「注释记成资产但没人守」的前科）。
 */
function shellTask(over: Partial<TaskDisplayInfo> = {}): TaskDisplayInfo {
  return {
    id: "s1",
    type: "local_shell",
    status: "running",
    description: "bun test",
    startTime: Date.now() - 5_000,
    durationMs: 1_000,
    ...over,
  };
}

describe("T-T1-11：无等待源时既有布局不变", () => {
  test("插入唤醒行不挤动既有任务行（整帧逐字符相同）", () => {
    const withoutWait = frameOf([shellTask()]);
    const withWait = frameOf([shellTask(), wakeupTask()]);

    const lineBefore = withoutWait.split("\n").find((l) => l.includes("bun test"));
    const lineAfter = withWait.split("\n").find((l) => l.includes("bun test"));
    expect(lineBefore).toBeDefined();
    // 唤醒行是**追加**在后面的，不该改写既有行的任何一列
    expect(lineAfter).toBe(lineBefore as string);
  });

  test("没有等待源时不出 [WK] / [MO] 行（不引入空壳行）", () => {
    const frame = frameOf([shellTask(), runningTask()]);
    expect(frame).not.toContain("[WK]");
    expect(frame).not.toContain("[MO]");
    // 也不该比「只有既有任务」时多出任何一行（不引入空壳/占位行）
    const baseLines = frameOf([shellTask(), runningTask()])
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(frame.split("\n").filter((l) => l.trim() !== "")).toHaveLength(baseLines.length);
  });
});
