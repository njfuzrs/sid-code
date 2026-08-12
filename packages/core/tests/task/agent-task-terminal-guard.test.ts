/**
 * 后台 Agent 任务终态保护 + kill 通知回归测试
 *
 * 对照 claude-code 排查发现的两个缺口：
 *
 * 缺口 A1（终态覆盖）：用户经 task_stop → killAgentTask 主动终止后台子代理时，
 *   killAgentTask 已设 killed 终态 + abort()；随后后台 execute 因 abort 走
 *   failAgentTask，此前 failAgentTask 无终态检查，把 killed 覆盖成 failed
 *   并误发"执行失败"通知。修复：fail/completeAgentTask 加 isTerminalStatus 短路。
 *
 * 缺口 A2（kill 静默消失）：killAgentTask 设 notified=true 却从不入队通知，
 *   导致被 kill 的任务被 evictTerminalTasks 驱逐后，用户既看不到面板条目、
 *   也收不到任何 <task-notification>，任务无声消失。修复：killAgentTask 补发
 *   killed 通知，与 complete/fail 对称。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getTask, clearAllTasks } from "@sid-code/core/task/index.ts";
import {
  createAgentTask,
  completeAgentTask,
  failAgentTask,
  killAgentTask,
} from "@sid-code/core/task/agent-task.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";
import type { LocalAgentTaskState, AgentTaskResult } from "@sid-code/core/task/types.ts";

// 注册表与通知队列均为进程级全局单例 → 每例前后清空，避免串扰。
beforeEach(() => {
  clearAllTasks();
  dequeuePendingNotifications(); // 排空残留通知
});

afterEach(() => {
  clearAllTasks();
  dequeuePendingNotifications();
});

const fakeResult: AgentTaskResult = {
  output: "子代理结论",
  totalToolUseCount: 3,
  totalTokens: 1000,
  usage: { inputTokens: 600, outputTokens: 400 },
};

describe("agent-task 终态保护（缺口 A1）", () => {
  test("killed 任务不被 failAgentTask 覆盖成 failed", async () => {
    const { taskState } = createAgentTask({ agentType: "explore", prompt: "p", description: "d" });
    dequeuePendingNotifications(); // 排空 create 阶段可能的通知（实际无）

    // 用户终止 → killed
    killAgentTask(taskState.id);
    expect((getTask(taskState.id) as LocalAgentTaskState).status).toBe("killed");

    // 后台 execute 因 abort 兜底调 failAgentTask —— 不应覆盖
    await failAgentTask(taskState.id, "aborted");
    expect((getTask(taskState.id) as LocalAgentTaskState).status).toBe("killed");
  });

  test("killed 任务不被 completeAgentTask 覆盖成 completed", async () => {
    const { taskState } = createAgentTask({ agentType: "task", prompt: "p", description: "d" });
    killAgentTask(taskState.id);

    // abort 后子代理碰巧返回成功结果 —— 不应覆盖 killed
    await completeAgentTask(taskState.id, fakeResult);
    expect((getTask(taskState.id) as LocalAgentTaskState).status).toBe("killed");
  });

  test("failed 任务不被二次 fail / complete 覆盖", async () => {
    const { taskState } = createAgentTask({ agentType: "explore", prompt: "p", description: "d" });
    await failAgentTask(taskState.id, "first failure");
    expect((getTask(taskState.id) as LocalAgentTaskState).status).toBe("failed");

    await failAgentTask(taskState.id, "second failure");
    await completeAgentTask(taskState.id, fakeResult);
    const t = getTask(taskState.id) as LocalAgentTaskState;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("first failure"); // 仍是首次错误，未被覆盖
  });
});

describe("agent-task kill 通知（缺口 A2）", () => {
  test("killAgentTask 入队 killed 通知（不再静默消失）", () => {
    const { taskState } = createAgentTask({
      agentType: "explore",
      prompt: "p",
      description: "排查任务",
    });

    killAgentTask(taskState.id);

    const notifications = dequeuePendingNotifications();
    expect(notifications.length).toBe(1);
    expect(notifications[0].content).toContain("<status>killed</status>");
    expect(notifications[0].content).toContain("排查任务");
    expect(notifications[0].content).toContain(taskState.id);
  });

  test("kill 已终态任务不重复发通知（幂等）", async () => {
    const { taskState } = createAgentTask({ agentType: "task", prompt: "p", description: "d" });
    await completeAgentTask(taskState.id, fakeResult);
    dequeuePendingNotifications(); // 排空 complete 通知

    killAgentTask(taskState.id); // 已 completed 终态
    expect(dequeuePendingNotifications().length).toBe(0);
    expect((getTask(taskState.id) as LocalAgentTaskState).status).toBe("completed");
  });

  test("complete / fail 各自仍正常发通知", async () => {
    const a = createAgentTask({ agentType: "explore", prompt: "p", description: "A" });
    await completeAgentTask(a.taskState.id, fakeResult);
    let n = dequeuePendingNotifications();
    expect(n.length).toBe(1);
    expect(n[0].content).toContain("<status>completed</status>");
    // 结构化快照与 XML 文本同源（TUI 走 structured、LLM 走 content）
    expect(n[0].structured?.status).toBe("completed");
    expect(n[0].structured?.taskId).toBe(a.taskState.id);

    const b = createAgentTask({ agentType: "task", prompt: "p", description: "B" });
    await failAgentTask(b.taskState.id, "boom");
    n = dequeuePendingNotifications();
    expect(n.length).toBe(1);
    expect(n[0].content).toContain("<status>failed</status>");
    expect(n[0].structured?.status).toBe("failed");
    // agent-task 的 failAgentTask 把 error 埋进 summary（不单独传 error 字段），
    // 故结构化 summary 应含错误信息。
    expect(n[0].structured?.summary).toContain("boom");
  });
});
