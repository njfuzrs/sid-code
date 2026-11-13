/**
 * R3 修法 2：新起后台等待时，回执里的「确定性状态事实」单测（2026-11-12）
 *
 * ## 要解决的事故（b0aa0f1e）
 *
 * 模型挂完一次等待后，后续每个请求的 thinking 都在复述「后台任务 sjgm4oq76 又被杀了」。
 * 上下文里最近那条 `<task-notification>` 是**上一轮**的，而模型没有任何可核对的事实，
 * 只能凭叙事拼一个故事。
 *
 * 修法 1（`notification-anchors.test.ts`）让通知自己带锚点；修法 2 在**新起等待的回执**
 * 里直接写死当前状态：此刻有没有待送达的通知、上一条已送达的是谁、什么时候。
 *
 * ## 为什么判据落在文案上
 *
 * 这句话是给模型的反证。删掉它时**没有任何东西会红**——回执照常返回、任务照常启动，
 * 只是模型又回到了「凭记忆猜」的状态。所以必须断言产物文本本身。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  __resetWaitRegistryForTest,
  registerWait,
  recordDeliveredTaskNotification,
  getLastDeliveredWaitNotice,
  describeBackgroundWaitFact,
} from "@sid-code/core/task/wait-registry.ts";
import {
  enqueueTaskNotification,
  dequeuePendingNotifications,
} from "@sid-code/core/task/notification.ts";
import { registerTask, clearAllTasks } from "@sid-code/core/task/registry.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

function makeShellTask(id: string): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: "等待",
    startTime: Date.now(),
    outputFile: "/tmp/x.txt",
    outputOffset: 0,
    notified: false,
    command: "sleep 1",
    interrupted: false,
    isBackgrounded: true,
  };
}

/** 登记一个等待源（让 taskId 进「曾作为等待源」集合） */
function registerWaitFor(id: string) {
  registerWait({
    id,
    kind: "shell",
    promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
    description: "等待",
    registeredAt: Date.now(),
  });
}

beforeEach(() => {
  __resetWaitRegistryForTest();
  clearAllTasks();
  dequeuePendingNotifications();
});

afterEach(() => {
  __resetWaitRegistryForTest();
  clearAllTasks();
  dequeuePendingNotifications();
});

describe("R3 回执事实：describeBackgroundWaitFact", () => {
  test("会话内没有已送达的等待类通知：只写前半句", () => {
    const fact = describeBackgroundWaitFact();
    expect(fact).toContain("此刻没有待送达的通知");
    expect(fact).not.toContain("不对应本次启动的任务");
  });

  test("有已送达的等待类通知：写清 id 与时刻，并点明「不对应本次启动的任务」", () => {
    registerWaitFor("local_shell_old");
    recordDeliveredTaskNotification("local_shell_old", "killed");

    const fact = describeBackgroundWaitFact();
    expect(fact).toContain("此刻没有待送达的通知");
    expect(fact).toContain("local_shell_old");
    expect(fact).toContain("的终态通知已在");
    // 事故里模型正是缺这一句才把旧通知当成了新结果
    expect(fact).toContain("不对应本次启动的任务");
  });

  test("非等待类任务送达不记（普通后台 shell 不是「在等外部状态」）", () => {
    // 不 registerWait → 不是等待源
    recordDeliveredTaskNotification("local_shell_plain", "completed");
    expect(getLastDeliveredWaitNotice()).toBeNull();
    expect(describeBackgroundWaitFact()).not.toContain("不对应本次启动的任务");
  });

  test("非终态通知不记（运行中的停滞提示不是结果）", () => {
    registerWaitFor("local_shell_running");
    recordDeliveredTaskNotification("local_shell_running", "running");
    expect(getLastDeliveredWaitNotice()).toBeNull();
  });

  test("有通知在排队时整句不写（排队中的通知模型还没看到，不能说「没有」）", () => {
    registerTask(makeShellTask("local_shell_pending"));
    enqueueTaskNotification({
      taskId: "local_shell_pending",
      outputFile: "/tmp/x.txt",
      status: "completed",
      summary: "done",
    });
    expect(describeBackgroundWaitFact()).toBe("");
  });

  test("多条送达：以最近一条为准", () => {
    registerWaitFor("waited_a");
    registerWaitFor("waited_b");
    recordDeliveredTaskNotification("waited_a", "completed");
    recordDeliveredTaskNotification("waited_b", "killed");
    expect(getLastDeliveredWaitNotice()?.taskId).toBe("waited_b");
    expect(describeBackgroundWaitFact()).toContain("waited_b");
  });
});
