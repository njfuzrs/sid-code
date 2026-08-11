/**
 * P1-4 Ctrl+B 热转后台单测：adoptRunningProcessAsTask（task/shell-task.ts）。
 *
 * 只校验"过继已在运行的前台进程"这段注册表 / 磁盘输出 / 终态收尾逻辑，用假进程
 * （只需 kill() 签名，不 spawn 真实子进程），保持纯逻辑单测的速度与确定性。
 * 真实前台 bash 命令的端到端 detach 流程（含 requestDetachForegroundBash 计数、
 * execute() 提前返回）见 tests/tool/bash-ctrlb-detach.test.ts。
 *
 * 覆盖：
 * - 过继后任务以 running + isBackgrounded=true 出现在注册表，alreadyCaptured 落盘；
 * - startTime 透传 vs 兜底当前时刻；
 * - appendLiveOutput 持续写盘（detach 之后的新增输出不丢）；
 * - markExited(0)/非 0 分别转 completed/failed 并各发一条对应通知；
 * - markError 转 failed，通知带上错误信息；
 * - 终态守卫（对齐 agent-task 的同类修复）：killShellTask 先行终止后，
 *   markExited/markError 不得把已广播的 killed 状态覆盖成 completed/failed，
 *   也不得再发第二条矛盾通知——此前 shell 任务未补齐这层守卫，随 P1-4 一并修正。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getTask,
  clearAllTasks,
  killShellTask,
  adoptRunningProcessAsTask,
  flushTaskOutput,
  getTaskOutputTail,
} from "@sid-code/core/task/index.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

/** 最小可过继进程：只需满足 AdoptableProcess（pid? + kill()），不 spawn 真实进程。 */
function makeFakeProc(pid?: number): { pid?: number; kill: (signal?: unknown) => void } {
  return { pid, kill: () => undefined };
}

// 注册表与通知队列均为进程级全局单例 → 每例前后清空，避免串扰（同 agent-task-terminal-guard.test.ts）。
beforeEach(() => {
  clearAllTasks();
  dequeuePendingNotifications();
});
afterEach(() => {
  clearAllTasks();
  dequeuePendingNotifications();
});

describe("adoptRunningProcessAsTask 基本过继", () => {
  test("登记为 running + isBackgrounded=true，alreadyCaptured 落盘", async () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "sleep 100",
      alreadyCaptured: "已有输出\n",
    });

    const task = getTask(handle.taskState.id) as LocalShellTaskState;
    expect(task.status).toBe("running");
    expect(task.isBackgrounded).toBe(true);
    expect(task.command).toBe("sleep 100");
    expect(task.interrupted).toBe(false);

    await flushTaskOutput(handle.taskState.id);
    const tail = await getTaskOutputTail(handle.taskState.id, 1024);
    expect(tail).toContain("已有输出");
  });

  test("不传 alreadyCaptured（空串）不写入任何内容", async () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "sleep 100",
      alreadyCaptured: "",
    });
    await flushTaskOutput(handle.taskState.id);
    const tail = await getTaskOutputTail(handle.taskState.id, 1024);
    expect(tail || "").toBe("");
  });

  test("startTime：不传时用当前时刻兜底，传了则原样透传真实起跑时刻", () => {
    const before = Date.now();
    const auto = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "sleep 1",
      alreadyCaptured: "",
    });
    expect(auto.taskState.startTime).toBeGreaterThanOrEqual(before);
    expect(auto.taskState.startTime).toBeLessThanOrEqual(Date.now() + 50);

    const manual = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "sleep 1",
      alreadyCaptured: "",
      startTime: 123456,
    });
    expect(manual.taskState.startTime).toBe(123456);
  });

  test("appendLiveOutput 持续写盘，与 alreadyCaptured 顺序拼接", async () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "tail -f x",
      alreadyCaptured: "第一段\n",
    });
    handle.appendLiveOutput("第二段\n");
    handle.appendLiveOutput("第三段\n");

    await flushTaskOutput(handle.taskState.id);
    const tail = await getTaskOutputTail(handle.taskState.id, 1024) ?? "";
    const i1 = tail.indexOf("第一段");
    const i2 = tail.indexOf("第二段");
    const i3 = tail.indexOf("第三段");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });
});

describe("adoptRunningProcessAsTask 终态收尾", () => {
  test("markExited(0) → completed，发出 completed 通知", () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "echo ok",
      alreadyCaptured: "",
    });
    handle.markExited(0);

    const task = getTask(handle.taskState.id) as LocalShellTaskState;
    expect(task.status).toBe("completed");
    expect(task.exitCode).toBe(0);

    const notes = dequeuePendingNotifications();
    const mine = notes.filter((n) => n.structured?.taskId === handle.taskState.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].structured?.status).toBe("completed");
  });

  test("markExited(非 0) → failed", () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "false",
      alreadyCaptured: "",
    });
    handle.markExited(1);

    const task = getTask(handle.taskState.id) as LocalShellTaskState;
    expect(task.status).toBe("failed");
    expect(task.exitCode).toBe(1);

    const notes = dequeuePendingNotifications();
    const mine = notes.filter((n) => n.structured?.taskId === handle.taskState.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].structured?.status).toBe("failed");
  });

  test("markExited(null) 退出码兜底为 -1", () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "kill -9 $$",
      alreadyCaptured: "",
    });
    handle.markExited(null);
    const task = getTask(handle.taskState.id) as LocalShellTaskState;
    expect(task.status).toBe("failed");
    expect(task.exitCode).toBe(-1);
  });

  test("markError → failed，通知带上错误信息", () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "boom",
      alreadyCaptured: "",
    });
    handle.markError(new Error("spawn 失败"));

    const task = getTask(handle.taskState.id) as LocalShellTaskState;
    expect(task.status).toBe("failed");

    const notes = dequeuePendingNotifications();
    const mine = notes.filter((n) => n.structured?.taskId === handle.taskState.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].structured?.result).toBe("spawn 失败");
  });
});

describe("adoptRunningProcessAsTask 终态守卫（对齐 agent-task 同类修复）", () => {
  test("killShellTask 先行终止后，markExited 不得覆盖 killed、不得再发矛盾通知", () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "sleep 100",
      alreadyCaptured: "",
    });

    killShellTask(handle.taskState.id);
    expect((getTask(handle.taskState.id) as LocalShellTaskState).status).toBe("killed");

    // 被 SIGKILL 的进程随后触发的"退出事件"落到这里——必须短路，不能覆盖成 completed/failed。
    handle.markExited(0);
    expect((getTask(handle.taskState.id) as LocalShellTaskState).status).toBe("killed");

    // 只应有 killShellTask 发的那一条 killed 通知，markExited 不应再补发矛盾的一条。
    const notes = dequeuePendingNotifications();
    const mine = notes.filter((n) => n.structured?.taskId === handle.taskState.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].structured?.status).toBe("killed");
  });

  test("killShellTask 先行终止后，markError 不得覆盖 killed、不得再发矛盾通知", () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "sleep 100",
      alreadyCaptured: "",
    });

    killShellTask(handle.taskState.id);
    handle.markError(new Error("迟到的 spawn 错误"));

    expect((getTask(handle.taskState.id) as LocalShellTaskState).status).toBe("killed");
    const notes = dequeuePendingNotifications();
    const mine = notes.filter((n) => n.structured?.taskId === handle.taskState.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].structured?.status).toBe("killed");
  });

  test("markExited 先落 completed 后，killShellTask 不应把它改判为 killed", () => {
    const handle = adoptRunningProcessAsTask({
      proc: makeFakeProc(),
      command: "echo ok",
      alreadyCaptured: "",
    });
    handle.markExited(0);
    expect((getTask(handle.taskState.id) as LocalShellTaskState).status).toBe("completed");

    // 进程已经自然退出、activeProcesses 早已被 markExited 清掉——kill 是幂等 no-op。
    killShellTask(handle.taskState.id);
    expect((getTask(handle.taskState.id) as LocalShellTaskState).status).toBe("completed");
  });
});
