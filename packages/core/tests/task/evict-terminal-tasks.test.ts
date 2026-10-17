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
  markNotificationsDelivered,
  markMainTurnCompleted,
  getCompletedMainTurns,
  hasPendingEviction,
  EVICT_GRACE_MS,
  UNDELIVERED_SAFETY_VALVE_MS,
} from "@sid-code/core/task/index.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

function makeShellTask(
  id: string,
  overrides: Partial<LocalShellTaskState> = {},
): LocalShellTaskState {
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
    updateTask<LocalShellTaskState>("t1", (t) => ({
      ...t,
      status: "completed",
      notified: true,
      endTime: 1,
    }));

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
    registerTask(
      makeShellTask("done-unnotified", { status: "completed", notified: false, endTime: 1 }),
    );
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
    const handler = () => {
      notified++;
    };
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
    const handler = () => {
      notified++;
    };
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
    registerTask(
      makeShellTask("done-notified", { status: "completed", notified: true, endTime: 1 }),
    );
    registerTask(
      makeShellTask("done-unnotified", { status: "completed", notified: false, endTime: 1 }),
    );

    evictTerminalTasks();

    expect(
      getAllTasks()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["done-unnotified", "running"]);
  });
});

// ─── S3：按回合驱逐（送达之后主循环又跑完至少一个回合）───
// 事故：`.output` 在模型读到之前被删。旧判据是「入队即 notified + 30s」，通知要到下一个
// 回合边界才进上下文，之后的模型调用可长达 116s。下面的用例全部用「刚完成」的 endTime，
// 墙钟时间不推进，只推进回合——证明判据看的是回合，不是毫秒。
describe("evictTerminalTasks（S3 按回合驱逐）", () => {
  const justDone = (id: string, over: Partial<LocalShellTaskState> = {}) =>
    makeShellTask(id, {
      status: "completed",
      notified: true,
      // 面板驻留期已过，排除这个下限的干扰，只测回合门
      endTime: Date.now() - EVICT_GRACE_MS - 1,
      ...over,
    });

  test("已入队但未送达：再久的毫秒窗口（安全阀以内）都不删", () => {
    registerTask(justDone("undelivered", { endTime: Date.now() - 5 * 60_000 }));
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["undelivered"]);
  });

  test("送达后紧跟一次 >30s 的模型调用，期间 TUI 定时器 tick：文件必须仍在", () => {
    registerTask(justDone("delivered"));
    markNotificationsDelivered(["delivered"]);
    // 送达回合内（模型正在跑那次长调用），1s 定时器 tick 多少次都不能删
    for (let i = 0; i < 120; i++) evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["delivered"]);
    // 送达回合内 hasPendingEviction 为 false：1s 定时器不该为它空转
    expect(hasPendingEviction()).toBe(false);
    // 主循环跑完这一轮 → 才允许删
    markMainTurnCompleted();
    expect(hasPendingEviction()).toBe(true);
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual([]);
  });

  test("送达回合已过但面板驻留期未过：仍保留（面板回看窗口）", () => {
    registerTask(justDone("fresh", { endTime: Date.now() }));
    markNotificationsDelivered(["fresh"]);
    markMainTurnCompleted();
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["fresh"]);
  });

  test("task_output 续期（evictAfter 在未来）是额外下限：送达回合已过也不删", () => {
    registerTask(justDone("renewed", { evictAfter: Date.now() + 60_000 }));
    markNotificationsDelivered(["renewed"]);
    markMainTurnCompleted();
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["renewed"]);
  });

  test("重复送达保留第一次的回合，不会被迟到的重复通知无限推后", () => {
    registerTask(justDone("dup"));
    markNotificationsDelivered(["dup"]);
    const first = getAllTasks()[0]!.notificationDeliveredTurn;
    markMainTurnCompleted();
    markNotificationsDelivered(["dup"]);
    expect(getAllTasks()[0]!.notificationDeliveredTurn).toBe(first);
    evictTerminalTasks();
    expect(getAllTasks()).toEqual([]);
  });

  test("安全阀：未送达的终态任务，完成后超过安全阀时长照样驱逐", () => {
    registerTask(justDone("stuck", { endTime: Date.now() - UNDELIVERED_SAFETY_VALVE_MS - 1 }));
    evictTerminalTasks();
    expect(getAllTasks()).toEqual([]);
  });

  test("未 notified 的终态任务：送达标记与回合推进都不让它被删", () => {
    registerTask(justDone("unnotified", { notified: false, endTime: 1 }));
    markNotificationsDelivered(["unnotified"]);
    markMainTurnCompleted();
    evictTerminalTasks();
    expect(getAllTasks().map((t) => t.id)).toEqual(["unnotified"]);
  });

  test("回合纪元单调递增", () => {
    const a = getCompletedMainTurns();
    markMainTurnCompleted();
    expect(getCompletedMainTurns()).toBe(a + 1);
  });

  // 变异自证：把判据改回「入队即可删、按毫秒计」（旧实现的形态）时，上面「送达后紧跟长调用」
  // 那条必须红。这里内联旧判据对同一状态求值，证明两个判据在这个时序上确实给出相反结论——
  // 否则上面的用例就可能是在一个两种实现都会通过的状态上空转。
  test("变异自证：旧的毫秒判据在同一状态下会删掉文件", () => {
    registerTask(justDone("mut"));
    markNotificationsDelivered(["mut"]);
    const t = getAllTasks()[0]!;
    const oldRule = t.notified && (t.evictAfter ?? 0) <= Date.now();
    expect(oldRule).toBe(true); // 旧判据：此刻就删
    evictTerminalTasks();
    expect(getAllTasks().map((x) => x.id)).toEqual(["mut"]); // 新判据：送达回合内保留
  });
});
