/**
 * F1/F2：后台任务终态结果的**投递所有权**——自动通道只许送达一次。
 *
 * 事故（会话 20261019-002707-0d3ddd0e）：4 个后台 explore 子代理，模型用 task_output 阻塞等到
 * 完成，同一批结果又以 <task-notification> 注入——同一条 user 消息里结论出现三份（task_output
 * 的 result + 输出流 + 通知的 <result>），合计 65,458 字符。这里锁：
 * 1. task_output 读到终态 → 撤回**该任务**的终态通知，其他任务通知原位保留；
 * 2. 反向（通知先注入）→ task_output 照常返回，属于显式重读；
 * 3. 注入与 hasPendingNotifications 同一过滤判据（撤回漏网也不进上下文、不空跑）；
 * 4. 运行中任务的停滞提示通知不被撤回；
 * 5. 终态 agent 的 task_output 返回体里结论只出现一次。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  updateTask,
  getTask,
  clearAllTasks,
  enqueueTaskNotification,
  hasPendingNotifications,
  claimResultDelivery,
  setTaskLifecycleSink,
  initTaskOutput,
  appendTaskOutput,
  flushTaskOutput,
} from "@sid-code/core/task/index.ts";
import { injectPendingNotifications } from "@sid-code/core/query/loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { __resetForTest, getQueueSnapshot } from "@sid-code/core/query/message-queue-manager.ts";
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import type { LocalAgentTaskState, LocalShellTaskState } from "@sid-code/core/task/types.ts";

const RESULT = "## 结论\n唯一结论 UNIQUE_CONCLUSION_MARKER";

function makeAgentTask(id: string): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: `排查 ${id}`,
    startTime: Date.now(),
    outputFile: `/tmp/${id}.output`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    agentType: "explore",
    prompt: "p",
    isBackgrounded: true,
  };
}

/** 后台 agent 走 completeAgentTask 同款状态：终态 + notified + 通知入队 */
function completeInBackground(id: string): void {
  updateTask<LocalAgentTaskState>(id, (t) => ({
    ...t,
    status: "completed",
    endTime: Date.now(),
    notified: true,
    result: {
      output: RESULT,
      totalToolUseCount: 3,
      totalTokens: 100,
      usage: { inputTokens: 80, outputTokens: 20 },
    },
  }));
  enqueueTaskNotification({
    taskId: id,
    outputFile: `/tmp/${id}.output`,
    status: "completed",
    summary: `Agent "${id}" 执行完成`,
    result: (getTask(id) as LocalAgentTaskState).result,
  });
}

function queuedNotifTaskIds(): string[] {
  return getQueueSnapshot()
    .filter((c) => c.kind === "task-notification")
    .map((c) => (c.payload as { structured?: { taskId: string } }).structured?.taskId ?? "");
}

let events: Array<Record<string, unknown>> = [];

beforeEach(() => {
  clearAllTasks();
  __resetForTest();
  events = [];
  setTaskLifecycleSink((d) => events.push(d));
});

afterEach(() => {
  setTaskLifecycleSink(null);
  clearAllTasks();
  __resetForTest();
});

describe("F1 投递所有权", () => {
  test("task_output 读到终态 → 撤回该任务通知，其他任务通知保留，pending 判据一致", async () => {
    registerTask(makeAgentTask("a1"));
    registerTask(makeAgentTask("a2"));
    completeInBackground("a1");
    completeInBackground("a2");
    expect(queuedNotifTaskIds()).toEqual(["a1", "a2"]);

    const r = await new TaskOutputTool().execute({ task_id: "a1", block: false });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("UNIQUE_CONCLUSION_MARKER");

    expect(queuedNotifTaskIds()).toEqual(["a2"]);
    expect(getTask("a1")!.resultDeliveredVia).toBe("tool_result");
    expect(getTask("a1")!.notificationDeliveredTurn).toBeDefined();
    expect(hasPendingNotifications()).toBe(true);

    const ctx = new ContextManager({ maxTokens: 200_000 });
    expect(injectPendingNotifications(ctx)).toBe(1);
    const delivered = events.filter((e) => e.phase === "delivered");
    expect(delivered.map((e) => [e.task_id, e.via])).toEqual([
      ["a1", "tool_result"],
      ["a2", "notification"],
    ]);
  });

  test("撤回漏网的已认领通知：注入跳过、hasPendingNotifications 为 false（不空跑一轮）", () => {
    registerTask(makeAgentTask("a1"));
    completeInBackground("a1");
    // 模拟「认领之后才入队」的竞态：直接认领，不经 task_output 的撤回
    expect(claimResultDelivery("a1", "tool_result")).toBe(true);
    expect(queuedNotifTaskIds()).toEqual(["a1"]);

    expect(hasPendingNotifications()).toBe(false);
    const ctx = new ContextManager({ maxTokens: 200_000 });
    expect(injectPendingNotifications(ctx)).toBe(0);
  });

  test("反向：通知先注入，再 task_output → 正常返回结果（显式重读不拦）", async () => {
    registerTask(makeAgentTask("a1"));
    completeInBackground("a1");
    injectPendingNotifications(new ContextManager({ maxTokens: 200_000 }));
    expect(getTask("a1")!.resultDeliveredVia).toBe("notification");

    const r = await new TaskOutputTool().execute({ task_id: "a1", block: false });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("UNIQUE_CONCLUSION_MARKER");
    expect(getTask("a1")!.resultDeliveredVia).toBe("notification");
  });

  test("运行中任务的停滞提示通知不被撤回", async () => {
    const shell: LocalShellTaskState = {
      id: "s1",
      type: "local_shell",
      status: "running",
      description: "s1",
      startTime: Date.now(),
      outputFile: "/tmp/s1.output",
      outputOffset: 0,
      notified: false,
      command: "read x",
      interrupted: false,
      isBackgrounded: true,
    };
    registerTask(shell);
    enqueueTaskNotification({
      taskId: "s1",
      outputFile: shell.outputFile,
      status: "running",
      summary: "疑似在等输入",
    });
    // 读取时任务已结束（终态），但队列里那条是**运行中**提示，不属于结果
    updateTask<LocalShellTaskState>("s1", (t) => ({
      ...t,
      status: "completed",
      exitCode: 0,
      endTime: Date.now(),
      notified: true,
    }));
    await new TaskOutputTool().execute({ task_id: "s1", block: false });
    expect(queuedNotifTaskIds()).toEqual(["s1"]);
    expect(hasPendingNotifications()).toBe(true);
  });
});

describe("F2 task_output 返回体", () => {
  test("终态 agent：结论只出现一次，不拼 .output 流，不是 JSON", async () => {
    registerTask(makeAgentTask("a1"));
    initTaskOutput("a1");
    appendTaskOutput("a1", `[轮次 1] ${RESULT}\n`);
    await flushTaskOutput("a1");
    completeInBackground("a1");

    const r = await new TaskOutputTool().execute({ task_id: "a1", block: false });
    const hits = r.output.split("UNIQUE_CONCLUSION_MARKER").length - 1;
    expect(hits).toBe(1);
    expect(r.output.startsWith("<task-output>")).toBe(true);
    expect(r.output).not.toContain('{"task_id"');
    expect(r.output).toContain("<status>completed</status>");
  });
});
