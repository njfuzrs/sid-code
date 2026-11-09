/**
 * monitor 的 TUI 呈现（PR 3）：事件行渲染 / MO 面板行 / Footer 计数 / Ctrl+F 文案
 *
 * 覆盖方案 §9.2.1 中属于 PR 3 的部分：
 * - T-M1-10：事件通知渲染成 `⏺ <description> · <首行>`（bullet 次要色）；多行进 `⎿`；
 *   40 列 + CJK 不折行；**绝不出现 `type: "user"`**
 * - T-T1-2：monitor 面板行的渲染文本不含任何事件内容（去重主断言）
 * - T-T1-5：`◐ [MO]`、统计列 `N 事件 · 剩 Xm`；剩余 < 2 分钟统计列 warning 色
 * - T-T1-6：Footer 的监控计数（纯函数判据）
 * - T-T1-10：Ctrl+F 确认文案列出类型计数（纯函数判据）
 *
 * 整帧渲染（不是纯函数断言）：这些缺陷纯函数单测全绿也照样存在，只有真渲染出帧
 * 才看得出（ui/CLAUDE.md L5.2）。
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import React from "react";
import chalk from "chalk";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { TaskNotificationMessage } from "@sid-code/cli/ui/components/messages/TaskNotificationMessage.tsx";
import { TodoPanel } from "@sid-code/cli/ui/components/TodoPanel.tsx";
import { BULLET } from "@sid-code/cli/ui/constants/figures.ts";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import { AccessibilityProvider } from "@sid-code/cli/ui/accessibility/AccessibilityContext.tsx";
import { deriveWaitSourcesHint } from "@sid-code/cli/ui/wait-sources-hint.ts";
import {
  clearAllTasks,
  describeRunningTasksForKillAll,
  registerTask,
} from "@sid-code/core/task/index.ts";
import type { TaskDisplayInfo } from "@sid-code/cli/ui/App.tsx";
import type { TaskType } from "@sid-code/core/task/types.ts";

const savedChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = savedChalkLevel;
});

const TERM_WIDTH = 100;
const NARROW_WIDTH = 40;

/** 渲染一条事件通知 */
function renderEvent(opts: {
  event: string;
  description?: string;
  terminalWidth?: number;
  eventCount?: number;
}): {
  raw: string;
  frame: string;
} {
  const { lastFrame } = render(
    <UIStateProvider>
      <TaskNotificationMessage
        summary="监控事件：PR #662 CI"
        status="running"
        event={opts.event}
        {...(opts.eventCount !== undefined ? { eventCount: opts.eventCount } : {})}
        description={opts.description ?? "PR #662 CI"}
        terminalWidth={opts.terminalWidth ?? TERM_WIDTH}
      />
    </UIStateProvider>,
  );
  const raw = lastFrame() ?? "";
  return { raw, frame: stripAnsi(raw) };
}

/** 一条运行中的 monitor 面板行 */
function monitorRow(over: Partial<TaskDisplayInfo> = {}): TaskDisplayInfo {
  return {
    id: "m7k2abcd",
    type: "local_monitor",
    kind: "monitor",
    status: "running",
    description: "PR #662 CI",
    command: "gh pr checks 662 --watch",
    eventCount: 3,
    deadlineAt: Date.now() + 22 * 60_000,
    startTime: Date.now() - 8 * 60_000,
    durationMs: 1_000,
    ...over,
  };
}

function frameOf(tasks: TaskDisplayInfo[], width = TERM_WIDTH): string {
  const { lastFrame } = render(<TodoPanel todos={[]} tasks={tasks} termWidth={width} />);
  return stripAnsi(lastFrame() ?? "");
}

describe("事件通知渲染（T-M1-10）", () => {
  test("摘要行 = `<description> · <event 首行>`，单行事件不画 ⎿", () => {
    const { frame } = renderEvent({ event: "lint: pass" });
    expect(frame).toContain("PR #662 CI · lint: pass");
    expect(frame).not.toContain("⎿");
  });

  test("多行事件：首行在摘要，其余进 ⎿ 折叠区", () => {
    const { frame } = renderEvent({
      event: "test (1/3): pass\ntest (2/3): pass\ntest (3/3): fail",
    });
    expect(frame).toContain("PR #662 CI · test (1/3): pass");
    expect(frame).toContain("⎿");
    expect(frame).toContain("test (2/3): pass");
  });

  test("bullet 用次要色（事件不是终态，不用绿/红/黄）", () => {
    const { frame } = renderEvent({ event: "lint: pass" });
    const line = frame.split("\n").find((l) => l.includes("PR #662 CI · lint: pass")) ?? "";
    // 用 BULLET 常量而不是字面量 `⏺`：字形随平台变（darwin ⏺ / 其它 ●，
    // 见 constants/figures.ts），写死会在 CI（ubuntu）上红。
    expect(line).toContain(BULLET);
  });

  test("40 列 + CJK：不把事件文本折成两行（截断而非折行）", () => {
    const long = "测试分片 ubuntu-latest 3/3 通过，覆盖率报告已上传";
    const { frame } = renderEvent({ event: long, terminalWidth: NARROW_WIDTH });
    const summaryLines = frame.split("\n").filter((l) => l.includes("PR #662 CI ·"));
    expect(summaryLines).toHaveLength(1);
  });

  test("事件走 task_notification，不是用户消息（绝不出现 `>` 正文色前缀）", () => {
    const { frame } = renderEvent({ event: "lint: pass" });
    // 用户消息的渲染特征是行首 `>`；事件行必须走 ⏺/⎿ 这一套（§2.4 的病灶）
    expect(frame.split("\n").some((l) => l.trimStart().startsWith("> "))).toBe(false);
  });
});

// D20 / T-M1-24：忙时积压的多条事件合成一项，摘要行说「N 条事件」，其下 ⎿ 逐行列出。
// 不合并就是同一个 monitor 在历史区刷 N 行（限流上限每分钟 6 条）。
describe("聚合事件渲染（D20 / T-M1-24）", () => {
  const threeEvents = "test (1/3): pass\ntest (2/3): pass\ntest (3/3): fail";

  test("eventCount=3：摘要行「<description> · 3 条事件」，三行正文都在 ⎿ 区", () => {
    const { frame } = renderEvent({ event: threeEvents, eventCount: 3 });
    const summaryLines = frame.split("\n").filter((l) => l.includes("PR #662 CI ·"));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain("3 条事件");
    // 聚合档摘要行不夹带任何一条事件正文（否则与「3 条事件」自相矛盾）
    expect(summaryLines[0]).not.toContain("test (1/3)");
    // 三行事件全在 ⎿ 折叠区（首行不再占摘要位）
    expect(frame).toContain("⎿");
    for (const line of threeEvents.split("\n")) expect(frame).toContain(line);
  });

  test("eventCount=1（缺省）仍走单条路径：首行在摘要，其余入 ⎿", () => {
    const { frame } = renderEvent({ event: threeEvents, eventCount: 1 });
    const summaryLines = frame.split("\n").filter((l) => l.includes("PR #662 CI ·"));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain("test (1/3): pass");
    expect(frame).not.toContain("3 条事件");
  });

  test("聚合档 bullet 仍是次要色（事件不是终态）", () => {
    const { frame } = renderEvent({ event: threeEvents, eventCount: 3 });
    const line = frame.split("\n").find((l) => l.includes("3 条事件")) ?? "";
    expect(line).toContain(BULLET);
  });

  test("40 列 + CJK：聚合摘要行不折成两行", () => {
    const { frame } = renderEvent({
      event: "测试分片 ubuntu-latest 3/3 通过\n覆盖率报告已上传",
      eventCount: 2,
      terminalWidth: NARROW_WIDTH,
    });
    const summaryLines = frame.split("\n").filter((l) => l.includes("PR #662 CI ·"));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain("2 条事件");
  });
});

describe("monitor 面板行（T-T1-5 / T-T1-2）", () => {
  test("运行中：`◐ [MO] <描述>` + 统计列「N 事件 · 剩 Xm」", () => {
    const frame = frameOf([monitorRow()]);
    expect(frame).toContain("[MO]");
    expect(frame).toContain("PR #662 CI");
    expect(frame).toMatch(/3 事件 · 剩 \d+m/);
  });

  test("去重主断言：面板行不含任何事件内容（事件只在消息流）", () => {
    const frame = frameOf([monitorRow({ description: "PR #662 CI" })]);
    expect(frame).not.toContain("lint: pass");
    expect(frame).not.toContain("test (1/3)");
  });

  test("剩余 < 2 分钟：统计列转 warning 色（克制点睛，只点统计列）", () => {
    const { lastFrame } = render(
      <TodoPanel
        todos={[]}
        tasks={[monitorRow({ deadlineAt: Date.now() + 30_000 })]}
        termWidth={TERM_WIDTH}
      />,
    );
    const raw = lastFrame() ?? "";
    const urgentLine = raw.split("\n").find((l) => l.includes("事件")) ?? "";
    expect(urgentLine).toMatch(/\x1b\[[0-9;]*m/);
    expect(stripAnsi(urgentLine)).toContain("剩 1m");
  });

  test("终态：`●` 绿 + 只显示「N 事件」（没有剩余时间）", () => {
    const frame = frameOf([monitorRow({ status: "completed", eventCount: 6 })]);
    expect(frame).toContain("●");
    expect(frame).toContain("6 事件");
    expect(frame).not.toContain("剩 ");
  });

  test("killed：`⊘` 黄（到期 / 被停）", () => {
    const frame = frameOf([monitorRow({ status: "killed", eventCount: 0 })]);
    expect(frame).toContain("⊘");
  });

  test("a11y 关动画：静态 ◐，但「剩 Xm」继续显示（数字不是动画）", () => {
    const { lastFrame } = render(
      <AccessibilityProvider initialEnabled={true}>
        <TodoPanel todos={[]} tasks={[monitorRow()]} termWidth={TERM_WIDTH} />
      </AccessibilityProvider>,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("◐");
    expect(frame).toMatch(/剩 \d+m/);
    expect(frame).not.toMatch(/[◓◑◒]/);
  });

  test("窄终端折叠文案含监控计数：`后台：1 监控`", () => {
    const frame = frameOf([monitorRow()], NARROW_WIDTH);
    expect(frame).toContain("后台：1 监控");
  });
});

describe("Footer 等待源提示：监控计数（T-T1-6）", () => {
  test("面板隐藏 + 有监控 → 「1 个监控」", () => {
    const hint = deriveWaitSourcesHint({ tasks: [monitorRow()], panelHidden: true });
    expect(hint?.counts).toBe("1 个监控");
  });

  test("监控 + 唤醒同时存在 → 「1 个监控 · 1 个唤醒等待中」", () => {
    const wakeup: TaskDisplayInfo = {
      id: "w1",
      type: "wakeup",
      kind: "wakeup",
      status: "waiting",
      description: "检查 CI",
      startTime: Date.now(),
      durationMs: 0,
      dueAt: Date.now() + 8 * 60_000,
    };
    const hint = deriveWaitSourcesHint({
      tasks: [monitorRow(), wakeup],
      panelHidden: true,
    });
    expect(hint?.counts).toBe("1 个监控 · 1 个唤醒等待中");
  });

  test("终态 monitor 不计入（它马上要被驱逐，不是「在等」）", () => {
    const hint = deriveWaitSourcesHint({
      tasks: [monitorRow({ status: "completed" })],
      panelHidden: true,
    });
    expect(hint).toBeNull();
  });

  test("面板可见时不出（面板里那行就在屏幕上）", () => {
    const hint = deriveWaitSourcesHint({ tasks: [monitorRow()], panelHidden: false });
    expect(hint).toBeNull();
  });
});

describe("Ctrl+F 确认文案列出类型计数（T-T1-10）", () => {
  beforeEach(() => clearAllTasks());
  afterEach(() => clearAllTasks());

  function fakeTask(id: string, type: TaskType, extra = {}) {
    const base = {
      id,
      type,
      status: "running" as const,
      description: `任务 ${id}`,
      startTime: Date.now(),
      outputFile: "",
      outputOffset: 0,
      notified: false,
      isBackgrounded: true,
      ...extra,
    };
    registerTask(base as never);
  }

  test("只有 monitor → 「1 个监控」", () => {
    fakeTask("m1", "local_monitor", {
      command: "true",
      deadlineAt: Date.now() + 60_000,
      eventCount: 0,
    });
    expect(describeRunningTasksForKillAll()).toBe("1 个监控");
  });

  test("monitor + shell → 「1 个监控、1 个 shell」", () => {
    fakeTask("m1", "local_monitor", {
      command: "true",
      deadlineAt: Date.now() + 60_000,
      eventCount: 0,
    });
    fakeTask("s1", "local_shell", { command: "bun test", interrupted: false });
    const text = describeRunningTasksForKillAll();
    expect(text).toContain("1 个监控");
    expect(text).toContain("1 个 shell");
  });

  test("没有运行中任务 → 空串（回退到通用文案）", () => {
    expect(describeRunningTasksForKillAll()).toBe("");
  });
});
