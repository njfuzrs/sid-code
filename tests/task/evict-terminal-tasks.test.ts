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

// ─── Bug 3 回归：驱逐缓冲期（三层门控第三层 evictAfter）───
// 背景：任务完成后立即被驱逐，主循环模型无法在多轮中再次 task_output 查询同一任务 →
// "任务 xxx 不存在"。修复：completeAgentTask/failAgentTask/killAgentTask 均设
// evictAfter = Date.now() + EVICT_GRACE_MS，evictTerminalTasks 只在 evictAfter <= now 时驱逐。
// 这些用例显式设置 evictAfter，触达三层门控的第三层（其余用例走「未设视为 0」兼容分支）。
describe("evictTerminalTasks（驱逐缓冲期 evictAfter）", () => {
  test("缓冲期未过（evictAfter 在未来）→ 已完成且已通知的任务仍保留", () => {
    registerTask(
      makeShellTask("buffered", {
        status: "completed",
        notified: true,
        endTime: Date.now(),
        evictAfter: Date.now() + 60_000, // 60s 后才允许驱逐
      }),
    );
    evictTerminalTasks();
    // 缓冲期内：模型仍能 task_output 查到，不得驱逐
    expect(getAllTasks().map((t) => t.id)).toEqual(["buffered"]);
  });

  test("缓冲期已过（evictAfter 在过去）→ 任务被驱逐", () => {
    registerTask(
      makeShellTask("expired", {
        status: "completed",
        notified: true,
        endTime: Date.now() - 120_000,
        evictAfter: Date.now() - 1_000, // 缓冲期已过
      }),
    );
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual([]);
  });

  test("缓冲期内即使已通知也不驱逐，过期后再调用才清除", () => {
    registerTask(
      makeShellTask("two-phase", {
        status: "completed",
        notified: true,
        endTime: Date.now(),
        evictAfter: Date.now() + 50, // 50ms 后过期
      }),
    );
    // 第一次：缓冲期内，保留
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["two-phase"]);

    // 手动把 evictAfter 推到过去，模拟缓冲期已过（避免测试真实 sleep）
    updateTask<LocalShellTaskState>("two-phase", (t) => ({ ...t, evictAfter: Date.now() - 1 }));
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual([]);
  });

  test("evictAfter 未设置（旧任务兼容）→ 视为 0，立即可驱逐", () => {
    registerTask(makeShellTask("legacy", { status: "completed", notified: true, endTime: 1 }));
    // 显式确认未设 evictAfter
    expect(getAllTasks()[0].evictAfter).toBeUndefined();
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual([]);
  });
});
