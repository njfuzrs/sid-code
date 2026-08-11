/**
 * TaskOutputTool 访问续期回归测试（可选优化「点2」）
 *
 * 背景：任务完成后 evictAfter = 完成时刻 + 60s，evictTerminalTasks 只在 evictAfter <= now
 * 时驱逐。固定窗口存在边界竞态：T0+59s 读取 → T0+60s 驱逐 → T0+61s 再读取失败。
 *
 * 修复：TaskOutputTool.execute 成功读取「终态」任务后刷新 evictAfter（LRU touch 语义），
 * 把驱逐窗口顺延，使活跃查询的任务不被误驱逐。running 任务本不被 evictTerminalTasks 驱逐，
 * 无需续期。
 *
 * 说明：这是消除罕见边界竞态的廉价保险，非业界通用做法——claude-code 靠 UI holding /
 * 用户 retain 决定生命周期，并不做「读一次续期」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  getTask,
  clearAllTasks,
  EVICT_GRACE_MS,
} from "@sid-code/core/task/index.ts";
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

function makeShellTask(id: string, overrides: Partial<LocalShellTaskState> = {}): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `task ${id}`,
    startTime: 0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: `echo ${id}`,
    interrupted: false,
    isBackgrounded: true,
    ...overrides,
  };
}

beforeEach(() => {
  clearAllTasks();
});

afterEach(() => {
  clearAllTasks();
});

describe("TaskOutputTool 访问续期（evictAfter touch）", () => {
  test("读取终态任务 → evictAfter 被顺延到未来（约 now + 60s）", async () => {
    // 完成任务，evictAfter 已快到期（仅剩 1s）
    const nearExpiry = Date.now() + 1_000;
    registerTask(
      makeShellTask("done", {
        status: "completed",
        notified: true,
        endTime: Date.now(),
        evictAfter: nearExpiry,
      }),
    );

    const tool = new TaskOutputTool();
    const before = Date.now();
    // 非阻塞读取（终态任务不进等待循环）
    const res = await tool.execute({ task_id: "done", block: false });
    expect(res.isError).toBeUndefined();

    const task = getTask("done");
    expect(task).toBeDefined();
    // 续期后 evictAfter 应被推到远未来（约 now + EVICT_GRACE_MS），远大于原来的 near-expiry。
    // 断言绑常量而非硬编码毫秒数：缓冲期时长是会被调的产品参数（2026-08-03 由 60s 收到
    // 30s 对齐 CC PANEL_GRACE_MS，见 tests/task/panel-dismiss.test.ts），本测试要看住的是
    // "续期把窗口推满一个完整缓冲期"这个行为，不是那个具体数字。
    expect(task!.evictAfter!).toBeGreaterThan(nearExpiry);
    expect(task!.evictAfter!).toBeGreaterThanOrEqual(before + EVICT_GRACE_MS - 1_000);
  });

  test("多次读取幂等续期：evictAfter 单调前进", async () => {
    registerTask(
      makeShellTask("multi", {
        status: "completed",
        notified: true,
        endTime: Date.now(),
        evictAfter: Date.now() + 1_000,
      }),
    );

    const tool = new TaskOutputTool();
    await tool.execute({ task_id: "multi", block: false });
    const first = getTask("multi")!.evictAfter!;

    // 稍等再读一次，evictAfter 应再次前进（不后退）
    await new Promise(r => setTimeout(r, 10));
    await tool.execute({ task_id: "multi", block: false });
    const second = getTask("multi")!.evictAfter!;

    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("running 任务不续期（本就不会被 evictTerminalTasks 驱逐）", async () => {
    // running 任务不设 evictAfter，读取（非阻塞）后仍应为 undefined
    registerTask(makeShellTask("running", { status: "running" }));

    const tool = new TaskOutputTool();
    await tool.execute({ task_id: "running", block: false });

    const task = getTask("running");
    expect(task).toBeDefined();
    expect(task!.evictAfter).toBeUndefined();
  });

  test("续期不改变任务其它字段（只 touch evictAfter）", async () => {
    registerTask(
      makeShellTask("stable", {
        status: "completed",
        notified: true,
        endTime: 12345,
        evictAfter: Date.now() + 1_000,
        exitCode: 0,
      }),
    );

    const tool = new TaskOutputTool();
    await tool.execute({ task_id: "stable", block: false });

    const task = getTask("stable") as LocalShellTaskState;
    expect(task.status).toBe("completed");
    expect(task.notified).toBe(true);
    expect(task.endTime).toBe(12345);
    expect(task.exitCode).toBe(0);
  });
});
