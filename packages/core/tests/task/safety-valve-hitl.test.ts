/**
 * F3-6：安全阀扣除人工等待（方案 §4.3 第 6 条、§4.5 验收第 2 条）。
 *
 * 事故背景（会话 20261103-f5beebde）：子代理 13:52:45 完成，主循环当时正卡在
 * fallback 询问弹窗里（HITL），10 分钟后任务被 `safety_valve` 驱逐——而用户
 * 01:44 才作答。安全阀的设计目的是兜「主循环不转了」，**等人不是不转了**。
 *
 * 时间控制用 bun 的 `setSystemTime`（`humanInputWaitElapsedMs` / `endTime` 都读 Date.now）。
 */

import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import {
  registerTask,
  updateTask,
  getTask,
  clearAllTasks,
  evictTerminalTasks,
  getTaskOutputTombstone,
  clearTaskOutputTombstones,
  markMainTurnCompleted,
  markNotificationsDelivered,
  UNDELIVERED_SAFETY_VALVE_MS,
} from "@sid-code/core/task/index.ts";
import {
  __resetHumanInputGate,
  beginHumanInputWait,
  endHumanInputWait,
} from "@sid-code/core/query/human-input-gate.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

/** 定一个远离真实时钟的基准时刻，避免与其它用例的 Date.now 串味。 */
const T0 = new Date("2026-11-04T00:00:00.000Z").getTime();

function makeTask(id: string): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `task ${id}`,
    startTime: T0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: `echo ${id}`,
    interrupted: false,
    isBackgrounded: true,
  };
}

/** 注册一个任务并把它推到「已完成、已入队（未送达）」——安全阀的适用状态。 */
function completedNotDelivered(id: string, endTime: number): void {
  registerTask(makeTask(id));
  updateTask<LocalShellTaskState>(id, (t) => ({
    ...t,
    status: "completed",
    endTime,
    notified: true,
  }));
}

beforeEach(() => {
  clearAllTasks();
  clearTaskOutputTombstones();
  __resetHumanInputGate();
  setSystemTime(new Date(T0));
});

afterEach(() => {
  setSystemTime();
  __resetHumanInputGate();
  clearAllTasks();
  clearTaskOutputTombstones();
});

describe("F3-6 安全阀扣除人工等待", () => {
  test("HITL 等待期间不驱逐（等人不是主循环不转了）", () => {
    completedNotDelivered("hitl", T0);

    beginHumanInputWait();
    setSystemTime(new Date(T0 + 15 * 60_000)); // 拨 15 分钟，用户一直没答
    evictTerminalTasks();

    expect(getTask("hitl")).toBeDefined();

    endHumanInputWait();
  });

  test("等待结束后按「安全阀 + 等待时长」驱逐，而不是立刻驱逐", () => {
    completedNotDelivered("hitl", T0);

    beginHumanInputWait();
    setSystemTime(new Date(T0 + 15 * 60_000));
    endHumanInputWait(); // 用户答完了，累计等待 15 分钟

    // 安全阀 10min + 等待 15min = 25min 才到点；此刻（15min）还不该删
    evictTerminalTasks();
    expect(getTask("hitl")).toBeDefined();

    setSystemTime(new Date(T0 + UNDELIVERED_SAFETY_VALVE_MS + 15 * 60_000 + 1));
    evictTerminalTasks();
    expect(getTask("hitl")).toBeUndefined();
    expect(getTaskOutputTombstone("hitl")?.reason).toBe("safety_valve");
  });

  test("终态之前的人工等待不扣（基线取终态快照）", () => {
    // 先等 5 分钟（这 5 分钟与「这次通知能不能送达」无关）
    beginHumanInputWait();
    setSystemTime(new Date(T0 + 5 * 60_000));
    endHumanInputWait();

    // 然后任务才完成
    completedNotDelivered("after", T0 + 5 * 60_000);

    // 再拨 10 分钟 + 1ms：安全阀到点即驱逐（只扣终态之后的等待，而终态之后没等）
    setSystemTime(new Date(T0 + 5 * 60_000 + UNDELIVERED_SAFETY_VALVE_MS + 1));
    evictTerminalTasks();
    expect(getTask("after")).toBeUndefined();
  });

  test("没有人工等待时行为不变（10 分钟到点驱逐）", () => {
    completedNotDelivered("plain", T0);

    setSystemTime(new Date(T0 + UNDELIVERED_SAFETY_VALVE_MS - 1));
    evictTerminalTasks();
    expect(getTask("plain")).toBeDefined();

    setSystemTime(new Date(T0 + UNDELIVERED_SAFETY_VALVE_MS + 1));
    evictTerminalTasks();
    expect(getTask("plain")).toBeUndefined();
  });

  test("已送达任务不受 HITL 判据影响（按回合驱逐那条路照旧）", () => {
    completedNotDelivered("delivered", T0);
    markNotificationsDelivered(["delivered"]);
    markMainTurnCompleted();

    beginHumanInputWait();
    setSystemTime(new Date(T0 + 60 * 60_000));
    evictTerminalTasks();
    endHumanInputWait();

    // 送达路径只看回合，与人工等待无关
    expect(getTask("delivered")).toBeUndefined();
  });

  test("终态跃迁写下 hitlWaitAtTerminalMs 快照（浮点边界的唯一依据）", () => {
    beginHumanInputWait();
    setSystemTime(new Date(T0 + 3 * 60_000));
    endHumanInputWait();

    completedNotDelivered("snap", T0 + 3 * 60_000);
    const t = getTask("snap")!;
    expect(t.hitlWaitAtTerminalMs).toBe(3 * 60_000);
  });
});
