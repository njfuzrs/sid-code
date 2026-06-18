/**
 * 后台任务驱逐回归测试
 *
 * Bug：TUI「后台任务 · N 已完成」永久驻留——终止态任务完成后从不从注册表清除，
 * 面板一直显示已完成条目。根因：evictTerminalTasks() 被导出但从未被调用，
 * 且即便调用也不通知监听器（面板不会重渲）。
 *
 * 修复：queryLoop 每轮在通知出队后调用 evictTerminalTasks()；
 * evictTerminalTasks 删除发生时 notifyTaskChanged 刷新 TUI。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  updateTask,
  getAllTasks,
  evictTerminalTasks,
  clearAllTasks,
  onTaskChanged,
  offTaskChanged,
} from "../../src/task/index.ts";
import type { LocalShellTaskState } from "../../src/task/types.ts";

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

// 注册表是进程级全局单例，其它测试可能残留任务 → 每例前后都清空，避免串扰。
beforeEach(() => {
  clearAllTasks();
});

afterEach(() => {
  clearAllTasks();
});

describe("evictTerminalTasks（终止态任务驱逐）", () => {
  test("已完成且已通知的任务被清除（修复面板永久驻留）", () => {
    registerTask(makeShellTask("t1"));
    updateTask<LocalShellTaskState>("t1", (t) => ({ ...t, status: "completed", notified: true, endTime: 1 }));

    expect(getAllTasks().map((t) => t.id)).toEqual(["t1"]);
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual([]);
  });

  test("运行中任务不被驱逐", () => {
    registerTask(makeShellTask("running"));
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["running"]);
  });

  test("终止态但尚未通知的任务保留（通知未注入对话前不清除）", () => {
    registerTask(makeShellTask("done-unnotified", { status: "completed", notified: false, endTime: 1 }));
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["done-unnotified"]);
  });

  test("失败 / 终止态同样在已通知后被驱逐", () => {
    registerTask(makeShellTask("failed", { status: "failed", notified: true, endTime: 1 }));
    registerTask(makeShellTask("killed", { status: "killed", notified: true, endTime: 1 }));
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual([]);
  });

  test("驱逐发生时通知监听器（面板得以重渲）", () => {
    registerTask(makeShellTask("t1", { status: "completed", notified: true, endTime: 1 }));
    let notified = 0;
    const handler = () => { notified++; };
    onTaskChanged(handler);
    try {
      evictTerminalTasks();
      expect(notified).toBe(1);
    } finally {
      offTaskChanged(handler);
    }
  });

  test("无可驱逐任务时不触发多余通知", () => {
    registerTask(makeShellTask("running"));
    let notified = 0;
    const handler = () => { notified++; };
    onTaskChanged(handler);
    try {
      evictTerminalTasks();
      expect(notified).toBe(0);
    } finally {
      offTaskChanged(handler);
    }
  });

  test("混合场景：仅清除已通知终止态，保留其余", () => {
    registerTask(makeShellTask("running"));
    registerTask(makeShellTask("done-notified", { status: "completed", notified: true, endTime: 1 }));
    registerTask(makeShellTask("done-unnotified", { status: "completed", notified: false, endTime: 1 }));

    evictTerminalTasks();

    expect(getAllTasks().map((t) => t.id).sort()).toEqual(["done-unnotified", "running"]);
  });
});
