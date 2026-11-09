/**
 * T-W2-3 / T-W2-5 / T-W2-8：T2 闸门（有带承诺的等待源 → end_turn 放行）的分支级用例。
 *
 * 方案 §9.1 点名的三格缺口，PR 1 Note 自报「需 mock 整套 queryLoop deps」未写；
 * 本文件用 `makeGateHarness`（同目录）从真实入口进：只 mock 模型层，
 * 等待源走真实的 `registerTask` + `registerWait`，T2 判据才真被验证。
 *
 * 三条各自锁住的东西：
 * - T-W2-3：只有 `wait_until` shell（静默 61s+ 但声明了期限）也能放行，且**不消耗**续命预算；
 * - T-W2-5：有 monitor 但清单剩的是不依赖它的项 —— 仍然放行。**这是 §10.1 接受的代价**，
 *   防止后来的人把它当 bug「修」掉；通知轮里闸门会再判，清单项不会被遗忘；
 * - T-W2-8：放行后下一轮请求上下文含等待源 reminder；等待源集合不变时第二次不重复注入；
 *   TUI 不再出现那行瞬态状态条（模型看不到的说明等于没写）。
 *
 * 隔离：task registry / wait registry / scheduler 都是模块级单例，用例间必须清干净
 * （否则上一个用例的 running 任务会被派生口径算成等待源）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeGateHarness } from "./gate-harness.ts";
import {
  WAIT_SOURCES_REMINDER_KEY,
  TODO_GATE_BUDGET_KEY,
} from "@sid-code/core/query/todo-reminder.ts";
import { clearAllTasks, registerTask } from "@sid-code/core/task/registry.ts";
import { __resetWaitRegistryForTest, registerWait } from "@sid-code/core/task/wait-registry.ts";
import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";
import {
  __resetBackgroundAwaitForTest,
  SHELL_QUIESCENT_MS,
  trackShellActivity,
} from "@sid-code/core/task/background-await.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";
import { resetScheduler } from "@sid-code/core/cron/scheduler.ts";
import type {
  LocalMonitorTaskState,
  LocalShellTaskState,
  TaskState,
} from "@sid-code/core/task/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

const T0 = Date.now();

/** 静默超过 SHELL_QUIESCENT_MS 的后台 shell（模拟 `wait_until` 等 CI 时没有新输出） */
function silentWaitUntilShell(id: string, description: string): LocalShellTaskState {
  const task: LocalShellTaskState = {
    id,
    type: "local_shell",
    status: "running",
    description,
    startTime: T0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: "wait_until 600s gh pr checks 662 --watch",
    interrupted: false,
    isBackgrounded: true,
  };
  registerTask(task);
  // 最后活动时间推到静默阈值之外：派生口径会判「不值得等」，只有显式 deadline 登记能救它
  trackShellActivity(id, 0, T0 - SHELL_QUIESCENT_MS - 1_000);
  return task;
}

function monitorTask(id: string, description: string, deadlineAt: number): LocalMonitorTaskState {
  const task: LocalMonitorTaskState = {
    id,
    type: "local_monitor",
    status: "running",
    description,
    startTime: T0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: "gh pr checks 662 --watch",
    deadlineAt,
    eventCount: 0,
    outputLines: 0,
    isBackgrounded: true,
  };
  registerTask(task);
  return task;
}

/** 未完成清单：两条待办（T2 只看「还有没有未完成项」，不看它们依赖谁） */
const UNFINISHED: TodoItem[] = [
  { content: "改文档", activeForm: "改文档", status: "completed" },
  { content: "等 CI 绿了合入", activeForm: "等 CI", status: "pending" },
  { content: "回归验证", activeForm: "回归验证", status: "in_progress" },
];

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-gate-wait-sources-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  resetScheduler();
});

afterEach(() => {
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("T2 闸门：带承诺的等待源 → 放行", () => {
  test("T-W2-3 只有 wait_until shell：一轮即收尾，且不消耗续命预算", async () => {
    silentWaitUntilShell("w-until", "等 PR #662 CI");
    registerWait({
      id: "w-until",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 600_000 },
      description: "等 PR #662 CI",
      registeredAt: Date.now(),
    });

    const h = makeGateHarness({ todos: UNFINISHED });
    const { llmCalls, systemTexts } = await h.run();

    // 放行 = 一次模型调用就收尾；被拦会续命 1 + MAX_TODO_GATE_RETRIES 次
    expect(llmCalls).toBe(1);
    expect(systemTexts.join("\n")).not.toContain("继续推进");
    // 「不消耗预算」：预算对象根本没有被推进（放行分支不碰 retries）
    const budget = h.sessionState.get(TODO_GATE_BUDGET_KEY) as
      | { retries: number; bgWaitSignature?: string }
      | undefined;
    expect(budget?.retries ?? 0).toBe(0);
    // 放行时写下了给模型的等待源清单（下一轮请求注入）
    expect(h.sessionState.get(WAIT_SOURCES_REMINDER_KEY)).toContain("正在等待");
  });

  test("T-W2-5 有 monitor 但清单剩的是不依赖它的项：仍放行（锁住 §10.1 已知代价）", async () => {
    // 这是方案明确接受的代价：harness 不判「清单项与监控对象的相关性」（判不准）。
    // 通知轮里闸门会再判一次，清单项不会因此被遗忘。本条防的是后来的人把它当 bug 改掉。
    const deadlineAt = Date.now() + 300_000;
    monitorTask("m-rel", "盯 PR #999 的 review", deadlineAt);
    registerWait({
      id: "m-rel",
      kind: "monitor",
      promise: { kind: "deadline", deadlineAt },
      description: "盯 PR #999 的 review",
      registeredAt: Date.now(),
    });

    const h = makeGateHarness({ todos: UNFINISHED });
    const { llmCalls, systemTexts } = await h.run();

    expect(llmCalls).toBe(1);
    expect(systemTexts.join("\n")).not.toContain("继续推进");
  });

  test("T-W2-8 放行后注入等待源 reminder；集合不变时第二次不重复；无旧瞬态状态条", async () => {
    const deadlineAt = Date.now() + 300_000;
    monitorTask("m-ci", "盯 PR #662 CI", deadlineAt);
    registerWait({
      id: "m-ci",
      kind: "monitor",
      promise: { kind: "deadline", deadlineAt },
      description: "盯 PR #662 CI",
      registeredAt: Date.now(),
    });

    const h = makeGateHarness({ todos: UNFINISHED });

    // 第一次：放行 → 把 reminder 写进 SessionState（下一轮请求才注入）
    const first = await h.run();
    expect(first.llmCalls).toBe(1);
    const pending = h.sessionState.get(WAIT_SOURCES_REMINDER_KEY) as string | undefined;
    expect(pending).toContain("正在等待");
    expect(pending).toContain("盯 PR #662 CI");
    // TUI 不再出现那行只给用户看的瞬态状态条（旧实现 yield 的文案）
    expect(first.systemTexts.join("\n")).not.toContain("正在等待后台任务回报");

    // 第二次：请求构造阶段吃掉 reminder 注入上下文；结束时签名没变 → 不再写第二份
    const second = await h.run();
    expect(second.llmCalls).toBe(1);
    const injected = second.requests
      .flatMap((msgs) => msgs)
      .map((m) => JSON.stringify(m.content))
      .join("\n");
    expect(injected).toContain("正在等待");
    expect(injected).toContain("盯 PR #662 CI");
    // 第二次没有再写 reminder（同一组等待源只注入一次）
    expect(h.sessionState.get(WAIT_SOURCES_REMINDER_KEY)).toBeUndefined();
  });

  test("T-W2-4 等待期 todo_write 把项标 blocked：T2 仍放行", async () => {
    // 等待源先存在（monitor 盯 PR #662）：这是「等待期」的定义
    const deadlineAt = Date.now() + 300_000;
    monitorTask("m-blocked", "盯 PR #662 CI", deadlineAt);
    registerWait({
      id: "m-blocked",
      kind: "monitor",
      promise: { kind: "deadline", deadlineAt },
      description: "盯 PR #662 CI",
      registeredAt: Date.now(),
    });

    // 等待期主会话写清单：把「等 CI」标成 blocked——这正是 todo_write 工具描述教的
    // 用法（blocked = 等外部系统），也是实测里模型的自然写法。D7 修复后 blocked
    // 算「还有事没做完」，不触发 S1；本用例锁住它同时**不改变 T2 的放行结论**。
    const main = new TodoWriteTool({ invalidatesWakeups: true });
    await main.execute({
      todos: [
        { content: "改文档", active_form: "改文档", status: "completed" },
        { content: "等 CI 绿了合入", active_form: "等 CI", status: "blocked" },
        { content: "回归验证", active_form: "回归验证", status: "in_progress" },
      ],
    });

    const h = makeGateHarness({ todos: main.getTodos() });
    const { llmCalls, systemTexts } = await h.run();

    // 放行 = 一次模型调用就收尾；被拦会续命 1 + MAX_TODO_GATE_RETRIES 次
    expect(llmCalls).toBe(1);
    expect(systemTexts.join("\n")).not.toContain("继续推进");
    // 清单里确实还有未完成项（blocked + in_progress），放行来自「有带承诺的等待源」
    expect(main.getTodos().filter((t) => t.status !== "completed")).toHaveLength(2);
    const pending = h.sessionState.get(WAIT_SOURCES_REMINDER_KEY) as string | undefined;
    expect(pending).toContain("正在等待");
    expect(pending).toContain("盯 PR #662 CI");
  });
});

/** 类型占位：让 TS 确认辅助函数构造的确实是注册表认的任务类型 */
const _typeCheck: TaskState = {} as LocalMonitorTaskState;
void _typeCheck;
