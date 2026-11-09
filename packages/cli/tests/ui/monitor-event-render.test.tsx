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
import { HistoryItemDisplay } from "@sid-code/cli/ui/components/HistoryItemDisplay.tsx";
import { messagesToHistoryItems } from "@sid-code/cli/ui/history-adapter.ts";
import type { HistoryItem, HistoryItemWithoutId } from "@sid-code/cli/ui/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { injectPendingNotifications } from "@sid-code/core/query/loop.ts";
import {
  dequeuePendingNotifications,
  enqueueTaskNotification,
} from "@sid-code/core/task/notification.ts";
import { parseSessionJsonl } from "@sid-code/core/session/store.ts";
import {
  __resetWaitRegistryForTest,
  hasPromisedWait,
  listWaits,
} from "@sid-code/core/task/wait-registry.ts";
import { TodoPanel } from "@sid-code/cli/ui/components/TodoPanel.tsx";
import { BULLET, TREE_BRANCH } from "@sid-code/cli/ui/constants/figures.ts";
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
function renderEvent(opts: { event: string; description?: string; terminalWidth?: number }): {
  raw: string;
  frame: string;
} {
  const { lastFrame } = render(
    <UIStateProvider>
      <TaskNotificationMessage
        summary="监控事件：PR #662 CI"
        status="running"
        event={opts.event}
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

// ── D20 / T-M1-24：忙时排队的多条事件合成一项 ──────────────────────────────

type NotifSnapshot = {
  taskId: string;
  status?: string;
  summary?: string;
  description?: string;
  event?: string;
  result?: string;
  outputFile?: string;
};

/**
 * 构造一条「主循环忙时一次性注入」的 user 消息。
 *
 * 形态与 `query/loop.ts` 的真实注入一致：`_meta.origin = "task-notification"`
 * + `_meta.notif` 是**数组**（一条消息聚合多条通知），正文只是 XML 文本。
 */
function notifMessage(notifs: NotifSnapshot[], opts: { singleObject?: boolean } = {}): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: notifs.map((n) => `<task-notification></task-notification>`).join("\n"),
      },
    ],
    _meta: {
      origin: "task-notification",
      notif: opts.singleObject ? notifs[0] : notifs,
    },
  };
}

/** 逐项渲染真实 HistoryItem（与 Static 列表逐项输出同形，读的是 adapter 产出） */
function renderItems(items: HistoryItemWithoutId[]): string {
  return items
    .map((it, i) => {
      const { lastFrame, unmount } = render(
        <UIStateProvider>
          <HistoryItemDisplay
            item={{ ...it, id: i + 1 } as HistoryItem}
            terminalWidth={TERM_WIDTH}
          />
        </UIStateProvider>,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      unmount();
      return frame;
    })
    .join("");
}

describe("忙时排队的多条事件合成一项（T-M1-24 / D20）", () => {
  test("同一消息内 3 条同 monitor 事件 → 一项、含「3 条事件」、三行都在", () => {
    // 方案 §5.7.4：主循环忙时事件在队列里攒着、一次性注入，TUI 原本是 3 个独立
    // 历史项（每条一行 `<description> · <首行>`），同一个 monitor 一多就刷屏。
    const msg = notifMessage([
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "lint: pass" },
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "test (1/3): pass" },
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "test (2/3): fail" },
    ]);
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "task_notification", taskId: "m1", eventCount: 3 });

    const frame = renderItems(items);
    expect(frame).toContain("PR #662 CI · 3 条事件");
    for (const line of ["lint: pass", "test (1/3): pass", "test (2/3): fail"]) {
      expect(frame).toContain(line);
    }
    // 摘要行被「3 条事件」占用，不再显示首行事件（否则「有几条」这个信号被挤掉）
    expect(frame).not.toContain("PR #662 CI · lint: pass");
    expect(frame).toContain(TREE_BRANCH);
  });

  test("不同 monitor 的事件不聚合（两项，各自单条渲染）", () => {
    const msg = notifMessage([
      { taskId: "m1", status: "running", description: "CI A", event: "a: pass" },
      { taskId: "m2", status: "running", description: "CI B", event: "b: pass" },
    ]);
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => (i as { eventCount?: number }).eventCount)).toEqual([
      undefined,
      undefined,
    ]);
    const frame = renderItems(items);
    expect(frame).toContain("CI A · a: pass");
    expect(frame).toContain("CI B · b: pass");
  });

  test("事件与终态混合：终态独立一项，顺序不被聚合吞掉", () => {
    const msg = notifMessage([
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "test: pass" },
      { taskId: "m1", status: "completed", summary: "监控结束：PR #662 CI", result: "共 1 条" },
    ]);
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ event: "test: pass" });
    expect((items[0] as { eventCount?: number }).eventCount).toBeUndefined();
    expect(items[1]).toMatchObject({
      status: "completed",
      summary: "监控结束：PR #662 CI",
    });
    expect((items[1] as { event?: string }).event).toBeUndefined();
  });

  test("旧会话（单个对象 _meta.notif）走原路径：单条事件渲染不变", () => {
    // 兼容早期实现：旧会话 resume 时 `_meta.notif` 是单个对象而非数组。
    const msg = notifMessage(
      [{ taskId: "m1", status: "running", description: "PR #662 CI", event: "lint: pass" }],
      { singleObject: true },
    );
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ event: "lint: pass" });
    expect((items[0] as { eventCount?: number }).eventCount).toBeUndefined();
    const frame = renderItems(items);
    expect(frame).toContain("PR #662 CI · lint: pass");
    expect(frame).not.toContain("条事件");
  });

  test("重建一致：同一条消息两次走 adapter 的结果逐字段相等", () => {
    // `/resume` 与实时渲染共用同一个 adapter（T-M1-17 同类），重建不能改变聚合结果。
    const msg = notifMessage([
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "a" },
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "b" },
    ]);
    const first = messagesToHistoryItems([msg]);
    const second = messagesToHistoryItems([msg]);
    expect(second).toEqual(first);
    expect(renderItems(second)).toBe(renderItems(first));
  });
});

describe("T-M1-17：/resume 含 monitor 事件的会话", () => {
  beforeEach(() => __resetWaitRegistryForTest());

  test("从 jsonl 恢复：事件与终态渲染正常，等待登记表为空", () => {
    // 真实入口：`--resume` 从落盘的 jsonl 解析（parseSessionJsonl），再把恢复出的
    // 消息喂给 TUI 的同一个 adapter。不能直接手搓 Message 数组——那样测的是
    // 「构造器 + 渲染」，跳过了落盘/解析这一层，正是 L4 清单里这条缺口的意思。
    const eventMsg = notifMessage([
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "lint: pass" },
      { taskId: "m1", status: "running", description: "PR #662 CI", event: "test: pass" },
    ]);
    const terminalMsg = notifMessage([
      {
        taskId: "m1",
        status: "completed",
        summary: "监控结束：PR #662 CI",
        result: "共 2 条",
        outputFile: "/tmp/m1.output",
      },
    ]);
    const lines = [
      JSON.stringify({
        type: "session_start",
        version: "3",
        sessionId: "s-resume-monitor",
        model: "test-model",
        provider: "test-provider",
        cwd: "/tmp",
        timestamp: "2026-01-02T03:04:05.000Z",
        uuid: "u0",
        parentUuid: null,
      }),
      JSON.stringify({
        type: "user_message",
        message: eventMsg,
        timestamp: "2026-01-02T03:04:06.000Z",
        uuid: "u1",
        parentUuid: "u0",
      }),
      JSON.stringify({
        type: "user_message",
        message: terminalMsg,
        timestamp: "2026-01-02T03:04:07.000Z",
        uuid: "u2",
        parentUuid: "u1",
      }),
    ];

    const data = parseSessionJsonl(lines.join("\n"));
    expect(data).not.toBeNull();
    expect(data!.messages).toHaveLength(2);

    const items = messagesToHistoryItems(data!.messages);
    const frame = renderItems(items);
    // 事件行渲染成折叠项：聚合计数 + 事件正文，且**不是** `>` 前缀的用户消息
    expect(frame).toContain("PR #662 CI · 2 条事件");
    expect(frame).toContain("lint: pass");
    expect(frame).toContain("test: pass");
    expect(frame).toContain("监控结束：PR #662 CI");
    expect(frame.split("\n").some((l) => l.trimStart().startsWith("> "))).toBe(false);

    // 登记表为空：恢复历史不会凭旧通知重建等待源（monitor 进程已随上个会话退出，
    // 新进程里没人能投递事件，凭历史登记会让闸门为一个不会来的等待放行）。
    expect(listWaits()).toHaveLength(0);
    expect(hasPromisedWait()).toBe(false);
  });
});

describe("MUT-9：事件通知靠 _meta.origin 保住 structured 渲染", () => {
  beforeEach(() => dequeuePendingNotifications());

  /**
   * 这是 T-M1-10 的真实入口版：从 `enqueueTaskNotification`（生产侧唯一入队入口）
   * → `injectPendingNotifications`（主循环注入点）→ adapter → 渲染，全程不手搓
   * `_meta`。去掉注入端的 `_meta.origin` 时，快速路径失效、退回正则解析 content：
   * XML 里**不带** event / description（那是 TUI 专用字段），于是渲染退化成
   * summary 行「监控事件：PR #662 CI」，「描述 · 首行」整段消失。
   *
   * 方案 MUT-9 原文预期「红在出现 type: user」——实测不成立：正则回退路径仍能
   * 识别 `<task-notification>` 块，不会退化成用户消息。等价的红点是「结构化字段
   * 丢失」这条断言（见 Agent Note 的变异记录）。
   */
  test("真实注入链路：事件渲染成「描述 · 首行」，不是 summary 行", () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    enqueueTaskNotification({
      taskId: "m1",
      outputFile: "/tmp/m1.output",
      status: "running",
      summary: "监控事件：PR #662 CI",
      event: "lint: pass\ntest: pass",
      description: "PR #662 CI",
    });

    const injected = injectPendingNotifications(ctxMgr);
    expect(injected).toBe(1);

    const items = messagesToHistoryItems(ctxMgr.getMessages());
    const frame = renderItems(items);
    // 结构化路径的标志：摘要行是 `<description> · <event 首行>`
    expect(frame).toContain("PR #662 CI · lint: pass");
    expect(frame).toContain("test: pass");
    // 且不走用户消息渲染（没有 `>` 前缀）
    expect(frame.split("\n").some((l) => l.trimStart().startsWith("> "))).toBe(false);
  });
});
