/**
 * clearInactiveTasks 回归测试
 *
 * /clear 应清掉面板上残留的旧（终止态）任务条目，但绝不能杀掉用户正在跑的后台 agent。
 * 此前 /clear 只清 UI 快照 tasks:[]，registry Map 不清 → 下次 notifyTaskChanged 旧条目复活；
 * 而直接用 clearAllTasks() 又会误杀 running 任务。clearInactiveTasks 只驱逐终止态、保留 running。
 *
 * 同时校验：clearAllTasks 现在连带通知监听器（此前仅 tasks.clear()、面板不重渲）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  getAllTasks,
  clearAllTasks,
  clearInactiveTasks,
  onTaskChanged,
  offTaskChanged,
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

beforeEach(() => {
  clearAllTasks();
});

afterEach(() => {
  clearAllTasks();
});

describe("clearInactiveTasks（/clear 清非运行态、保留 running）", () => {
  test("终止态任务被清除（不论是否已通知），运行中保留", () => {
    registerTask(makeShellTask("running"));
    registerTask(
      makeShellTask("done-notified", { status: "completed", notified: true, endTime: 1 }),
    );
    registerTask(
      makeShellTask("done-unnotified", { status: "completed", notified: false, endTime: 1 }),
    );
    registerTask(makeShellTask("failed", { status: "failed", notified: false, endTime: 1 }));
    registerTask(makeShellTask("killed", { status: "killed", notified: true, endTime: 1 }));

    clearInactiveTasks();

    // 仅 running 保留；终止态无论 notified 与否全部清除（区别于 evictTerminalTasks 只清已通知）。
    expect(getAllTasks().map((t) => t.id)).toEqual(["running"]);
  });

  test("不误杀正在运行的后台 agent", () => {
    registerTask(makeShellTask("r1"));
    registerTask(makeShellTask("r2"));
    clearInactiveTasks();
    expect(
      getAllTasks()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["r1", "r2"]);
  });

  test("有清除发生时通知监听器（面板重渲）", () => {
    registerTask(makeShellTask("done", { status: "completed", notified: true, endTime: 1 }));
    let notified = 0;
    const handler = () => {
      notified++;
    };
    onTaskChanged(handler);
    try {
      clearInactiveTasks();
      expect(notified).toBe(1);
    } finally {
      offTaskChanged(handler);
    }
  });

  test("无可清除任务时不触发多余通知", () => {
    registerTask(makeShellTask("running"));
    let notified = 0;
    const handler = () => {
      notified++;
    };
    onTaskChanged(handler);
    try {
      clearInactiveTasks();
      expect(notified).toBe(0);
    } finally {
      offTaskChanged(handler);
    }
  });
});

describe("clearAllTasks（会话结束全清 + 通知）", () => {
  test("清空全部任务（含 running）并通知监听器", () => {
    registerTask(makeShellTask("running"));
    registerTask(makeShellTask("done", { status: "completed", notified: true, endTime: 1 }));
    let notified = 0;
    const handler = () => {
      notified++;
    };
    onTaskChanged(handler);
    try {
      clearAllTasks();
      expect(getAllTasks()).toEqual([]);
      expect(notified).toBe(1);
    } finally {
      offTaskChanged(handler);
    }
  });
});
