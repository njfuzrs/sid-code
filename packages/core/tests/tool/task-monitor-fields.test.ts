/**
 * D17：monitor 在三个任务查询工具里都要能看到 `deadline` 与 `event-count`。
 *
 * 背景（方案 D17）：`bg_task_list` / `bg_task_get` / `task_output` 对 monitor 只输出
 * 通用字段，模型想知道「最晚几点结束、已经报了几条」得去读 `.output` 文件。
 * 状态签名侧的用例在 `tests/task/background-poll-guard.test.ts`（事件数算进展），
 * 这里锁三个工具的输出字段。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registerTask, clearAllTasks } from "@sid-code/core/task/index.ts";
import { TaskListTool } from "@sid-code/core/tool/task-list.ts";
import { TaskGetTool } from "@sid-code/core/tool/task-get.ts";
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import type { LocalMonitorTaskState } from "@sid-code/core/task/types.ts";

/**
 * 固定本地 03:04:05。构造与格式化都走本地时区，断言与运行机器的时区无关
 * （`formatClockWithSeconds` 的语义就是本地时钟，不做 UTC 换算）。
 */
const DEADLINE = new Date(2026, 0, 2, 3, 4, 5).getTime();

function monitorTask(over: Partial<LocalMonitorTaskState> = {}): LocalMonitorTaskState {
  return {
    id: "m1",
    type: "local_monitor",
    status: "running",
    description: "监控 CI",
    startTime: Date.now(),
    outputFile: "/tmp/sid-code-test-m1.output",
    outputOffset: 0,
    notified: false,
    command: "gh pr checks 123",
    deadlineAt: DEADLINE,
    eventCount: 2,
    outputLines: 5,
    isBackgrounded: true,
    ...over,
  };
}

beforeEach(() => clearAllTasks());
afterEach(() => clearAllTasks());

describe("D17：bg_task_list 输出 monitor 的 deadline 与 event-count", () => {
  test("两个字段都在（此前只有通用字段）", async () => {
    registerTask(monitorTask());
    const r = await new TaskListTool().execute({});
    expect(r.output).toContain("<deadline>03:04:05</deadline>");
    expect(r.output).toContain("<event-count>2</event-count>");
  });
});

describe("D17：bg_task_get 输出 monitor 的 command / deadline / event-count", () => {
  test("三个字段都在", async () => {
    registerTask(monitorTask());
    const r = await new TaskGetTool().execute({ task_id: "m1", block: false });
    expect(r.output).toContain("<command>gh pr checks 123</command>");
    expect(r.output).toContain("<deadline>03:04:05</deadline>");
    expect(r.output).toContain("<event-count>2</event-count>");
  });

  test("超长 command 截断到 500 字（与 shell 同）", async () => {
    registerTask(monitorTask({ command: "x".repeat(600) }));
    const r = await new TaskGetTool().execute({ task_id: "m1", block: false });
    expect(r.output).toContain(`<command>${"x".repeat(500)}</command>`);
    expect(r.output).not.toContain("x".repeat(501));
  });
});

describe("D17：task_output 输出 monitor 的 deadline 与 event-count", () => {
  test("非终态快照（block=false）两个字段都在", async () => {
    registerTask(monitorTask());
    const r = await new TaskOutputTool().execute({ task_id: "m1", block: false });
    expect(r.output).toContain("<deadline>03:04:05</deadline>");
    expect(r.output).toContain("<event-count>2</event-count>");
  });
});
