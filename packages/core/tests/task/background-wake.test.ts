/**
 * 空闲唤醒：端到端（不含 LLM）
 *
 * 事故 20261016-124505-786b1586 的形状——主循环 end_turn 之后、后台子代理才完成，
 * 通知入了队列但没有任何人消费，任务静默停住。本文件测「谁去消费」这一环。
 *
 * 刻意不 mock 队列/注册表：断链正是发生在子系统之间，用 mock 把两边接起来测，
 * 测的就是 mock 而不是生产接线（见 CLAUDE.md「目标指标改善 + 测试全绿 + 机理讲得通，
 * 三者同时成立时结论仍然可能是错的」）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  waitForBackgroundNotification,
  subscribeBackgroundActivity,
  hasRunningBackgroundTasks,
} from "@sid-code/core/task/background-wake.ts";
import {
  completeAgentTask,
  killAgentTask,
  createAgentTask,
} from "@sid-code/core/task/agent-task.ts";
import { getTask } from "@sid-code/core/task/registry.ts";
import { drainByKind, __resetForTest } from "@sid-code/core/query/message-queue-manager.ts";

const result = {
  output: "子代理结论",
  totalToolUseCount: 1,
  totalTokens: 10,
  usage: { inputTokens: 8, outputTokens: 2 },
};

/** 建一个后台子代理任务（与生产同一入口 createAgentTask），返回 taskId */
function spawnBackgroundTask(description = "核验文档"): string {
  const { taskState, abortController } = createAgentTask({
    agentType: "explore",
    prompt: "核验官网文档",
    description,
    isBackgrounded: true,
  });
  abortControllers.set(taskState.id, abortController);
  return taskState.id;
}

/** 保持 abortController 存活，避免 GC 后 abort 失效（生产由 agent-task 内部 Map 持有） */
const abortControllers = new Map<string, AbortController>();

let spawned: string[] = [];

beforeEach(() => {
  __resetForTest();
  // 上一用例留下的终态任务会被 hasRunningBackgroundTasks 过滤掉，但为免注册表串味先收尾
  for (const id of spawned) {
    const t = getTask(id);
    if (t && t.status === "running") t.status = "completed";
  }
  spawned = [];
});

describe("waitForBackgroundNotification", () => {
  test("无运行中任务且无待投递通知 → 立即 idle（不挂等待，不空转）", async () => {
    expect(hasRunningBackgroundTasks()).toBe(false);
    expect(await waitForBackgroundNotification()).toBe("idle");
  });

  test("有运行中任务 → 挂起等待；任务完成后通知入队 → 返回 notification", async () => {
    const id = spawnBackgroundTask();
    spawned.push(id);
    expect(hasRunningBackgroundTasks()).toBe(true);

    const pending = waitForBackgroundNotification();
    // 任务在跑、通知还没入队：应当挂起，而不是立刻判定 idle
    expect(await Promise.race([pending, Promise.resolve("still-waiting" as const)])).toBe(
      "still-waiting",
    );

    await completeAgentTask(id, result);
    expect(await pending).toBe("notification");
    // 通知确实在队列里，消费方拿得到
    expect(drainByKind("task-notification")).toHaveLength(1);
  });

  test("任务被 kill → 返回 notification（killed 也补发通知，不能让任务无声消失）", async () => {
    const id = spawnBackgroundTask();
    spawned.push(id);
    const pending = waitForBackgroundNotification();
    killAgentTask(id);
    expect(await pending).toBe("notification");
    expect(drainByKind("task-notification")).toHaveLength(1);
  });

  test("等待是「看一眼」不是「取走」：返回 notification 后通知仍留给消费方", async () => {
    const id = spawnBackgroundTask();
    spawned.push(id);
    const pending = waitForBackgroundNotification();
    await completeAgentTask(id, result);
    expect(await pending).toBe("notification");
    // 关键不变量：唤醒方只做 peek。若它顺手 drain 掉，真正的消费方
    // （engine.resumeWithNotifications）就再也拿不到这条通知——任务静默消失。
    expect(drainByKind("task-notification")).toHaveLength(1);
  });

  test("signal 已中止 → 立即 aborted（会话超时不把等待挂死）", async () => {
    const id = spawnBackgroundTask();
    spawned.push(id);
    const ac = new AbortController();
    ac.abort();
    expect(await waitForBackgroundNotification(ac.signal)).toBe("aborted");
  });

  test("等待期间 signal 中止 → 返回 aborted", async () => {
    const id = spawnBackgroundTask();
    spawned.push(id);
    const ac = new AbortController();
    const pending = waitForBackgroundNotification(ac.signal);
    ac.abort();
    expect(await pending).toBe("aborted");
  });
});

describe("subscribeBackgroundActivity", () => {
  test("完成一个后台任务会触发监听，且回调里已能看到待投递通知", async () => {
    const id = spawnBackgroundTask();
    spawned.push(id);
    let sawNotificationOnFire = false;
    const unsubscribe = subscribeBackgroundActivity(() => {
      // 关键判据：completeAgentTask 先 updateTask 再 enqueueTaskNotification，
      // 回调若同步触发就会看到「无运行任务 + 无通知」而误判结束。必须已能看到通知。
      if (drainByKind("task-notification").length > 0) sawNotificationOnFire = true;
    });

    await completeAgentTask(id, result);
    await new Promise((r) => setTimeout(r, 0));
    expect(sawNotificationOnFire).toBe(true);
    unsubscribe();
  });

  test("全程同步的 updateTask → enqueue 序列里，回调不在同步栈上触发", () => {
    const id = spawnBackgroundTask();
    spawned.push(id);
    let firedAtAll = false;
    const unsubscribe = subscribeBackgroundActivity(() => {
      firedAtAll = true;
    });

    // killAgentTask 是纯同步的：updateTask（同步通知监听器）→ enqueueTaskNotification，
    // 中间没有 await。所以「返回后回调是否已经跑过」就是同步 vs 微任务的干净判据
    // （用 completeAgentTask 测不了：它开头就 await flushTaskOutput，await 本身会让微任务插队）。
    killAgentTask(id);
    // 同步栈上必须还没跑：此刻通知刚入队、回调若同步触发就会读到一个空队列而误判结束。
    expect(firedAtAll).toBe(false);
    unsubscribe();
  });
});
