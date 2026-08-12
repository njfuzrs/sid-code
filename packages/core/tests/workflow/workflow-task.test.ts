/**
 * Dynamic Workflows M6 — task 类型注册 + 后台 workflow 任务生命周期单测
 *
 * WorkflowTool.execute 依赖真实 ProviderRegistry(打 LLM),不适合单测;这里固化 M6 的可
 * 隔离单元:① local_workflow task 类型注册正确;② workflow-task 生命周期(create→complete/
 * fail→notification);③ task ID 前缀 w。端到端的引擎联调已在 runtime/journal 测试覆盖。
 */

import { test, expect, describe, afterEach } from "bun:test";
import {
  generateTaskId,
  isWorkflowTask,
  type LocalWorkflowTaskState,
} from "@sid-code/core/task/types.ts";
import {
  createWorkflowTask,
  completeWorkflowTask,
  failWorkflowTask,
  updateWorkflowProgress,
  killWorkflowTask,
  getWorkflowTaskSignal,
} from "@sid-code/core/task/workflow-task.ts";
import { getTask, clearAllTasks } from "@sid-code/core/task/registry.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";

afterEach(() => {
  clearAllTasks();
  dequeuePendingNotifications(); // 清空通知队列避免串台
});

describe("M6 task 类型 — local_workflow 注册", () => {
  test("workflow task ID 前缀为 w", () => {
    const id = generateTaskId("local_workflow");
    expect(id.startsWith("w")).toBe(true);
    expect(id.length).toBe(9); // w + 8 位
  });

  test("isWorkflowTask 类型守卫", () => {
    const wf: LocalWorkflowTaskState = {
      id: "wabc",
      type: "local_workflow",
      status: "running",
      description: "d",
      startTime: 0,
      outputFile: "/tmp/x",
      outputOffset: 0,
      notified: false,
      workflowName: "test",
      runId: "wf_x",
      source: "inline",
      isBackgrounded: true,
    };
    expect(isWorkflowTask(wf)).toBe(true);
  });
});

describe("M6 workflow-task — 生命周期", () => {
  test("create 注册 running 任务", () => {
    const { taskState } = createWorkflowTask({
      workflowName: "audit",
      runId: "wf_abc",
      source: "inline",
      description: "审计 workflow",
    });
    const fetched = getTask(taskState.id) as LocalWorkflowTaskState | undefined;
    expect(fetched).toBeDefined();
    expect(fetched?.type).toBe("local_workflow");
    expect(fetched?.status).toBe("running");
    expect(fetched?.workflowName).toBe("audit");
    expect(fetched?.runId).toBe("wf_abc");
  });

  test("updateWorkflowProgress 更新 agentCount / currentPhase", () => {
    const { taskState } = createWorkflowTask({
      workflowName: "wf",
      runId: "wf_1",
      source: "inline",
      description: "d",
    });
    updateWorkflowProgress(taskState.id, { agentCount: 5, currentPhase: "Verify" });
    const t = getTask(taskState.id) as LocalWorkflowTaskState;
    expect(t.agentCount).toBe(5);
    expect(t.currentPhase).toBe("Verify");
  });

  test("complete 标记 completed + 发通知", async () => {
    const { taskState } = createWorkflowTask({
      workflowName: "wf",
      runId: "wf_2",
      source: "inline",
      description: "d",
    });
    await completeWorkflowTask(taskState.id, {
      output: '{"result":"ok"}',
      totalToolUseCount: 3,
      totalTokens: 100,
      usage: { inputTokens: 0, outputTokens: 100 },
    });
    const t = getTask(taskState.id) as LocalWorkflowTaskState;
    expect(t.status).toBe("completed");
    expect(t.notified).toBe(true);
    const notifs = dequeuePendingNotifications();
    expect(notifs.length).toBeGreaterThan(0);
    expect(notifs.map((n) => n.content).join("")).toContain("wf");
  });

  test("fail 标记 failed + 发通知", async () => {
    const { taskState } = createWorkflowTask({
      workflowName: "wf",
      runId: "wf_3",
      source: "inline",
      description: "d",
    });
    await failWorkflowTask(taskState.id, "脚本语法错误");
    const t = getTask(taskState.id) as LocalWorkflowTaskState;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("脚本语法错误");
  });

  test("kill 标记 killed 并触发 abort 信号", () => {
    const { taskState, abortController } = createWorkflowTask({
      workflowName: "wf",
      runId: "wf_4",
      source: "inline",
      description: "d",
    });
    expect(abortController.signal.aborted).toBe(false);
    const signal = getWorkflowTaskSignal(taskState.id);
    expect(signal).toBeDefined();
    const ok = killWorkflowTask(taskState.id);
    expect(ok).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    const t = getTask(taskState.id) as LocalWorkflowTaskState;
    expect(t.status).toBe("killed");
  });

  test("kill 补发 killed 通知(不再无声消失)", () => {
    // 回归守卫:此前 killWorkflowTask 设 notified=true 却从不入队通知,
    // 被 kill 的 workflow 被 evictTerminalTasks 静默驱逐、用户收不到反馈。
    const { taskState } = createWorkflowTask({
      workflowName: "my-audit",
      runId: "wf_kill_notif",
      source: "inline",
      description: "d",
    });
    killWorkflowTask(taskState.id);
    const notifs = dequeuePendingNotifications();
    expect(notifs.length).toBeGreaterThan(0);
    const joined = notifs.map((n) => n.content).join("");
    expect(joined).toContain("my-audit"); // 通知里带 workflow 名
    expect(joined.toLowerCase()).toContain("kill"); // killed 状态
  });

  test("终态保护:complete 后再 fail 不覆盖状态", async () => {
    const { taskState } = createWorkflowTask({
      workflowName: "wf",
      runId: "wf_5",
      source: "inline",
      description: "d",
    });
    await completeWorkflowTask(taskState.id, {
      output: "ok",
      totalToolUseCount: 0,
      totalTokens: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await failWorkflowTask(taskState.id, "迟到的失败");
    const t = getTask(taskState.id) as LocalWorkflowTaskState;
    expect(t.status).toBe("completed"); // 未被覆盖
  });
});
