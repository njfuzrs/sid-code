/**
 * TaskOutputTool 增量 delta 回归测试（P1-1）
 *
 * 背景：修复前 outputOffset 恒为 0 从不写回，每次 task_output 都从字节 0 重新读再
 * .slice(0,30000)，长时间输出的后台任务模型永远只看到最初 30000 字符，看不到新增尾部
 * ——与"增量读取"语义完全相反。
 *
 * 修复：读取后把 delta.newOffset 写回任务 outputOffset，下次调用只返回自上次以来的新增部分。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  getTask,
  clearAllTasks,
  initTaskOutput,
  appendTaskOutput,
  flushTaskOutput,
  getTaskOutputTail,
} from "@sid-code/core/task/index.ts";
// appendTaskOutput/flushTaskOutput 经 appendAndWait 间接使用
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

/** 追加内容后等磁盘真正落盘（drain 是异步的，flush 有竞态，靠轮询兜底）。 */
async function appendAndWait(taskId: string, content: string, marker: string): Promise<void> {
  appendTaskOutput(taskId, content);
  await flushTaskOutput(taskId);
  for (let i = 0; i < 50; i++) {
    const tail = await getTaskOutputTail(taskId, 1024 * 1024);
    if (tail && tail.includes(marker)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

describe("TaskOutputTool 增量 delta", () => {
  test("第二次读取只返回新增输出，不重复开头", async () => {
    registerTask(
      makeShellTask("delta", { status: "completed", notified: true, endTime: Date.now() }),
    );
    initTaskOutput("delta");

    // 第一段输出
    await appendAndWait("delta", "FIRST_CHUNK\n", "FIRST_CHUNK");

    const tool = new TaskOutputTool();
    const r1 = await tool.execute({ task_id: "delta", block: false });
    expect(r1.output).toContain("FIRST_CHUNK");

    // offset 应已被写回推进（> 0）
    const afterFirst = getTask("delta")!.outputOffset;
    expect(afterFirst).toBeGreaterThan(0);

    // 追加第二段
    await appendAndWait("delta", "SECOND_CHUNK\n", "SECOND_CHUNK");

    const r2 = await tool.execute({ task_id: "delta", block: false });
    // 第二次只返回新增，不再重复 FIRST_CHUNK
    expect(r2.output).toContain("SECOND_CHUNK");
    expect(r2.output).not.toContain("FIRST_CHUNK");
  });

  test("无新增输出时返回「无新增输出」而非重复内容", async () => {
    registerTask(
      makeShellTask("nonew", { status: "completed", notified: true, endTime: Date.now() }),
    );
    initTaskOutput("nonew");
    await appendAndWait("nonew", "ONLY_CHUNK\n", "ONLY_CHUNK");

    const tool = new TaskOutputTool();
    const r1 = await tool.execute({ task_id: "nonew", block: false });
    expect(r1.output).toContain("ONLY_CHUNK");

    // 没有新追加，再读一次
    const r2 = await tool.execute({ task_id: "nonew", block: false });
    expect(r2.output).toContain("无新增输出");
    expect(r2.output).not.toContain("ONLY_CHUNK");
  });

  test("首次读取空输出任务返回「无输出」", async () => {
    registerTask(
      makeShellTask("empty", { status: "completed", notified: true, endTime: Date.now() }),
    );
    initTaskOutput("empty");
    await flushTaskOutput("empty");

    const tool = new TaskOutputTool();
    const r = await tool.execute({ task_id: "empty", block: false });
    expect(r.output).toContain("无输出");
  });
});
