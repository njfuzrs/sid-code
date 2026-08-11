/**
 * P1-4 killAllRunningTasks / hasRunningTasks 单测（Ctrl+F 终止全部后台任务）。
 *
 * 只校验聚合与分派逻辑：
 * - hasRunningTasks 正确反映是否有 running 任务；
 * - killAllRunningTasks 把所有 running 任务置为 killed 终态，返回终止数；
 * - 已终态任务不被重复处理（getRunningTasks 已过滤），返回数只计 running。
 *
 * 用 shell 任务：无活跃子进程时 killShellTask 走幂等分支——仅改状态 + 发 killed 通知，
 * 不 spawn 真实进程，适合纯逻辑单测。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  getAllTasks,
  clearAllTasks,
  killAllRunningTasks,
  hasRunningTasks,
} from "@sid-code/core/task/index.ts";
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

beforeEach(() => { clearAllTasks(); });
afterEach(() => { clearAllTasks(); });

describe("hasRunningTasks", () => {
  test("无任务时为 false", () => {
    expect(hasRunningTasks()).toBe(false);
  });

  test("有 running 任务时为 true", () => {
    registerTask(makeShellTask("r1"));
    expect(hasRunningTasks()).toBe(true);
  });

  test("仅终止态任务时为 false", () => {
    registerTask(makeShellTask("done", { status: "completed", endTime: 1 }));
    expect(hasRunningTasks()).toBe(false);
  });
});

describe("killAllRunningTasks", () => {
  test("终止所有 running 任务并返回数量", () => {
    registerTask(makeShellTask("r1"));
    registerTask(makeShellTask("r2"));
    registerTask(makeShellTask("done", { status: "completed", endTime: 1 }));

    const n = killAllRunningTasks();
    expect(n).toBe(2); // 只计 running

    // 原 running 的两个应转 killed 终态；原 completed 不变。
    const byId = Object.fromEntries(getAllTasks().map((t) => [t.id, t.status]));
    expect(byId["r1"]).toBe("killed");
    expect(byId["r2"]).toBe("killed");
    expect(byId["done"]).toBe("completed");
  });

  test("无 running 任务时返回 0、no-op", () => {
    registerTask(makeShellTask("done", { status: "failed", endTime: 1 }));
    expect(killAllRunningTasks()).toBe(0);
    expect(getAllTasks().find((t) => t.id === "done")?.status).toBe("failed");
  });
});
