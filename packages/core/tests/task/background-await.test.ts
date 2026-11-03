/**
 * 「在跑」≠「值得等」+ 空闲主循环唤醒保证（事故 20261103-130950-00ef059c）
 *
 * 事故形状：后台常驻假服务器一直在跑、从不退出 → todo 闸门 T2 以「有后台任务、等它回报」放行
 * 收尾 → 那条回报永远不会来，会话静默停住。
 *
 * 前半段测纯口径（注入 now）；后半段用真实 spawnShellTask + 真实看门狗 tick，不 mock 队列与
 * 注册表——断链发生在子系统之间，mock 接起来测的是 mock。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  SHELL_QUIESCENT_MS,
  trackShellActivity,
  recordShellOutputSize,
  isAwaitedBackgroundTask,
  hasAwaitedBackgroundTasks,
  beginMainLoopTurn,
  endMainLoopTurn,
  takeQuiescentWake,
  __resetBackgroundAwaitForTest,
} from "@sid-code/core/task/background-await.ts";
import { waitForBackgroundNotification } from "@sid-code/core/task/background-wake.ts";
import { spawnShellTask, killShellTask } from "@sid-code/core/task/shell-task.ts";
import { createAgentTask } from "@sid-code/core/task/agent-task.ts";
import { getTask } from "@sid-code/core/task/registry.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";
import { drainByKind, __resetForTest } from "@sid-code/core/query/message-queue-manager.ts";

const T0 = 1_000_000;

function shellTask(id: string): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: "server",
    startTime: T0,
    outputFile: "/dev/null",
    outputOffset: 0,
    notified: false,
    command: "bun run server.ts",
    interrupted: false,
    isBackgrounded: true,
  };
}

beforeEach(() => {
  __resetBackgroundAwaitForTest();
  __resetForTest();
});

describe("isAwaitedBackgroundTask：后台 shell 静默后不再算「值得等」", () => {
  test("刚起跑 / 一直有输出 → 值得等；连续静默 ≥ 阈值 → 不值得等", () => {
    const t = shellTask("b-silent");
    trackShellActivity(t.id, 0, T0);
    expect(isAwaitedBackgroundTask(t, T0 + 1_000)).toBe(true);

    // 持续有输出：每次增长都刷新锚点
    recordShellOutputSize(t.id, 100, T0 + 50_000);
    expect(isAwaitedBackgroundTask(t, T0 + 50_000 + SHELL_QUIESCENT_MS - 1)).toBe(true);

    // 字节数不变：静默满阈值即不再值得等
    recordShellOutputSize(t.id, 100, T0 + 100_000);
    expect(isAwaitedBackgroundTask(t, T0 + 50_000 + SHELL_QUIESCENT_MS)).toBe(false);
  });

  test("前台 shell、终态任务都不算", () => {
    const fg = { ...shellTask("b-fg"), isBackgrounded: false };
    const done = { ...shellTask("b-done"), status: "completed" as const };
    expect(isAwaitedBackgroundTask(fg, T0)).toBe(false);
    expect(isAwaitedBackgroundTask(done, T0)).toBe(false);
  });

  test("后台子代理不受静默口径影响：终态必有通知，始终值得等", () => {
    const { taskState } = createAgentTask({
      agentType: "explore",
      prompt: "x",
      description: "x",
      isBackgrounded: true,
    });
    try {
      expect(isAwaitedBackgroundTask(taskState, Date.now() + 10 * SHELL_QUIESCENT_MS)).toBe(true);
    } finally {
      const t = getTask(taskState.id);
      if (t) t.status = "completed";
    }
  });
});

describe("takeQuiescentWake：只唤醒「收尾时在等、之后静默」的任务，且只一次", () => {
  // 这组只验状态机，任务登记用 trackShellActivity，不需要注册表
  test("主循环忙时不唤醒；收尾未登记的不唤醒（登记后唤醒一次见下方端到端）", () => {
    const id = "b-wake";
    trackShellActivity(id, 0, T0);
    // 未经 endMainLoopTurn 登记
    expect(takeQuiescentWake(id, T0 + SHELL_QUIESCENT_MS)).toBe(false);

    beginMainLoopTurn();
    // 主循环忙：即便静默也不唤醒（它会在回合边界自己看到状态）
    expect(takeQuiescentWake(id, T0 + SHELL_QUIESCENT_MS)).toBe(false);
  });
});

describe("真实 shell 任务端到端：常驻服务不会让空闲主循环永远等下去", () => {
  let spawned: string[] = [];
  afterEach(() => {
    for (const id of spawned) killShellTask(id);
    spawned = [];
    __resetForTest();
  });

  test("收尾时在等的后台 shell 转入静默 → 看门狗投 running 通知，等待方被叫醒", async () => {
    // 常驻、无输出：等价于事故里的假服务器
    const task = spawnShellTask({ command: "sleep 30", cwd: process.cwd() });
    spawned.push(task.id);

    // 主循环跑完一轮收尾：此刻任务刚起跑，值得等 → 被登记
    beginMainLoopTurn();
    endMainLoopTurn();
    expect(hasAwaitedBackgroundTasks()).toBe(true);

    // 等待方（headless / TUI 空闲续跑）开始等
    const waiting = waitForBackgroundNotification();

    // 把「最后一次有输出」拨回阈值之前：等价于服务器已静默 60s
    trackShellActivity(task.id, 0, Date.now() - SHELL_QUIESCENT_MS - 1_000);

    // 看门狗 5s 一个 tick
    expect(await waiting).toBe("notification");
    const notifs = drainByKind("task-notification");
    expect(notifs).toHaveLength(1);
    const content = String((notifs[0]!.payload as { content: string }).content);
    expect(content).toContain(task.id);
    expect(content).toContain("<status>running</status>");
    expect(content).toContain("不会再自动回报");

    // 唤醒只投一次：静默之后不再值得等，等待方立刻得到 idle 而不是挂住
    expect(hasAwaitedBackgroundTasks()).toBe(false);
    expect(await waitForBackgroundNotification()).toBe("idle");
    expect(getTask(task.id)?.status).toBe("running");
  }, 15_000);
});
