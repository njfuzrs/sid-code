/**
 * F4 补（20261019 follow-up）：task_output 阻塞等待期间上报一行进度。
 *
 * 原方案 §4 F4 要求「等待中：卡片下给一行进度（等待任务完成 · esc 可中断）」，
 * 但 #358 只做了 header 和结果正文，等待期间卡片仍然不动——4 个并行 task_output
 * 阻塞 3–5 分钟时，用户看不出它在等、也不知道能 esc 中断。
 *
 * 这里锁两件事：
 * 1. block=true 等待时立即上报，且文案含「等待任务完成 / 已等 Ns / esc 可中断」；
 * 2. block=false 不等待，就不该有任何等待进度（不产生假的“正在等”信号）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registerTask, updateTask, clearAllTasks } from "@sid-code/core/task/index.ts";
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import type { LocalAgentTaskState } from "@sid-code/core/task/types.ts";

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

beforeEach(() => {
  clearAllTasks();
});

afterEach(() => {
  clearAllTasks();
});

describe("task_output 等待进度上报", () => {
  test("阻塞等待期间上报「等待任务完成 · 已等 Ns · esc 可中断」", async () => {
    registerTask(makeAgentTask("w1"));
    const events: string[] = [];
    // 150ms 后完成任务；等待循环是 500ms 轮询，所以至少会走「立即上报 + 完成任务」
    const timer = setTimeout(() => {
      updateTask<LocalAgentTaskState>("w1", (t) => ({
        ...t,
        status: "completed",
        endTime: Date.now(),
        notified: true,
      }));
    }, 150);

    const r = await new TaskOutputTool().execute(
      { task_id: "w1", block: true, timeout: 2000 },
      undefined,
      (e) => events.push(String((e as { text?: unknown }).text ?? "")),
    );
    clearTimeout(timer);

    expect(r.isError).toBeFalsy();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toContain("等待任务完成");
    expect(events[0]).toContain("已等");
    expect(events[0]).toContain("esc 可中断");
  });

  test("等待期间进度持续刷新（秒数递增），任务结束后不再多报一条「仍在等」", async () => {
    registerTask(makeAgentTask("w3"));
    const events: Array<{ text: string; at: number }> = [];
    let completedAt = Infinity;
    // 1.2s 后完成：500ms 轮询下应至少报 3 次（0s / ~1s），且秒数单调递增
    const timer = setTimeout(() => {
      completedAt = Date.now();
      updateTask<LocalAgentTaskState>("w3", (t) => ({
        ...t,
        status: "completed",
        endTime: Date.now(),
        notified: true,
      }));
    }, 1200);

    await new TaskOutputTool().execute(
      { task_id: "w3", block: true, timeout: 5000 },
      undefined,
      (e) => events.push({ text: String((e as { text?: unknown }).text ?? ""), at: Date.now() }),
    );
    clearTimeout(timer);

    // 锁「循环内刷新」：只保留首次上报时这里只有 1 条
    expect(events.length).toBeGreaterThanOrEqual(3);
    const secs = events.map((e) => Number(/已等 (\d+)s/.exec(e.text)?.[1]));
    expect(secs.every((n) => Number.isFinite(n))).toBe(true);
    for (let i = 1; i < secs.length; i++) expect(secs[i]!).toBeGreaterThanOrEqual(secs[i - 1]!);
    expect(secs[secs.length - 1]!).toBeGreaterThan(secs[0]!);
    // 锁上报顺序：上报在终态判定之后，任务完成后不得再出「仍在等」
    expect(events.filter((e) => e.at > completedAt)).toEqual([]);
  });

  test("block=false 不产生等待进度（没等就别说自己在等）", async () => {
    registerTask(makeAgentTask("w2"));
    const events: string[] = [];
    await new TaskOutputTool().execute({ task_id: "w2", block: false }, undefined, (e) =>
      events.push(String((e as { text?: unknown }).text ?? "")),
    );
    expect(events).toEqual([]);
  });
});
