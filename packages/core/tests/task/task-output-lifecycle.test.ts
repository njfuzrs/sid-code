/**
 * S3 / S16：后台任务输出生命周期——送达语义、墓碑、TaskLifecycle 事件。
 *
 * 事故（会话 20261016-124310-ebff882b）：模型主动读后台任务 `.output`，文件已被「入队 + 30s」
 * 的计时删掉，read 工具回「文件不存在」，任务的启动 / 完成 / 驱逐在轨迹里一条都没有。
 * 这里锁三件事：
 * 1. 「已送达」只在通知真正进上下文时（injectPendingNotifications）置位，入队不算；
 * 2. 驱逐前登记墓碑，read 工具读已驱逐的 `.output` 给墓碑而不是通用「文件不存在」；
 * 3. started / completed / delivered / evicted 四个阶段各落一条事件，且
 *    「evicted 与 delivered 同回合」不会出现。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  registerTask,
  updateTask,
  getTask,
  clearAllTasks,
  evictTerminalTasks,
  initTaskOutput,
  markMainTurnCompleted,
  setTaskLifecycleSink,
  getTaskOutputTombstone,
  clearTaskOutputTombstones,
  taskIdFromOutputPath,
  EVICT_GRACE_MS,
  enqueueTaskNotification,
} from "@sid-code/core/task/index.ts";
import { injectPendingNotifications } from "@sid-code/core/query/loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { __resetForTest } from "@sid-code/core/query/message-queue-manager.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

let events: Array<Record<string, unknown>> = [];

function makeShellTask(id: string, outputFile: string): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `task ${id}`,
    startTime: Date.now(),
    outputFile,
    outputOffset: 0,
    notified: false,
    command: `echo ${id}`,
    interrupted: false,
    isBackgrounded: true,
  };
}

/** 注册一个真有 `.output` 文件的任务，并把它推到「已完成、已入队、面板驻留期已过」 */
function completedWithOutput(id: string, content: string): string {
  const out = initTaskOutput(id);
  writeFileSync(out.filePath, content);
  registerTask(makeShellTask(id, out.filePath));
  updateTask<LocalShellTaskState>(id, (t) => ({
    ...t,
    status: "completed",
    exitCode: 0,
    endTime: Date.now() - EVICT_GRACE_MS - 1,
    notified: true,
  }));
  enqueueTaskNotification({
    taskId: id,
    outputFile: out.filePath,
    status: "completed",
    summary: `命令 ${id} 执行成功`,
  });
  return out.filePath;
}

beforeEach(() => {
  clearAllTasks();
  clearTaskOutputTombstones();
  __resetForTest();
  events = [];
  setTaskLifecycleSink((d) => events.push(d));
});

afterEach(() => {
  setTaskLifecycleSink(null);
  clearAllTasks();
  clearTaskOutputTombstones();
  __resetForTest();
});

describe("送达语义：入队 ≠ 送达", () => {
  test("入队后、注入前：无论 tick 多少次都不删 .output（事故时序）", () => {
    const file = completedWithOutput("q1", "hello\n");
    for (let i = 0; i < 60; i++) evictTerminalTasks();
    markMainTurnCompleted(); // 回合推进也不行——通知还没进上下文
    evictTerminalTasks();
    expect(getTask("q1")).toBeDefined();
    expect(existsSync(file)).toBe(true);
    expect(getTask("q1")!.notificationDeliveredTurn).toBeUndefined();
  });

  test("injectPendingNotifications 置送达回合；本回合内不删，回合跑完才删", async () => {
    const file = completedWithOutput("q2", "line-a\nline-b\n");
    const ctx = new ContextManager({ maxTokens: 200_000 });
    expect(injectPendingNotifications(ctx)).toBe(1);
    expect(getTask("q2")!.notificationDeliveredTurn).toBeNumber();

    evictTerminalTasks(); // 本回合（模型正要读）
    expect(existsSync(file)).toBe(true);

    markMainTurnCompleted();
    evictTerminalTasks();
    expect(getTask("q2")).toBeUndefined();
    // unlink 是 fire-and-forget，等它落地
    for (let i = 0; i < 50 && existsSync(file); i++) await Bun.sleep(10);
    expect(existsSync(file)).toBe(false);
  });
});

describe("墓碑", () => {
  test("驱逐前留存尾部输出，read 工具读已驱逐的 .output 返回墓碑", async () => {
    const file = completedWithOutput("tb1", "build ok\nDONE-MARKER\n");
    injectPendingNotifications(new ContextManager({ maxTokens: 200_000 }));
    markMainTurnCompleted();
    evictTerminalTasks();
    for (let i = 0; i < 50 && existsSync(file); i++) await Bun.sleep(10);

    const tb = getTaskOutputTombstone("tb1");
    expect(tb?.status).toBe("completed");
    expect(tb?.exitCode).toBe(0);
    expect(tb?.reason).toBe("delivered_turn_passed");
    expect(tb?.tail).toContain("DONE-MARKER");

    const res = await new ReadTool().execute({ file_path: file });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("已被清理");
    expect(res.output).toContain("DONE-MARKER");
  });

  test("没有墓碑记录的任务 .output（如上个会话）：给说明而不是通用「文件不存在」", async () => {
    const file = join(sidPaths.tasks(), "ghost123.output");
    const res = await new ReadTool().execute({ file_path: file });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("后台任务输出文件已不存在");
    expect(res.output).toContain("ghost123");
  });

  test("taskIdFromOutputPath 只认 tasks 目录下的 <id>.output", () => {
    expect(taskIdFromOutputPath(join(sidPaths.tasks(), "abc.output"))).toBe("abc");
    expect(taskIdFromOutputPath(join(sidPaths.tasks(), "abc.txt"))).toBeNull();
    expect(taskIdFromOutputPath("/tmp/abc.output")).toBeNull();
  });
});

describe("TaskLifecycle 事件（S16）", () => {
  test("四个阶段各一条，且 evicted 的回合晚于 delivered", () => {
    completedWithOutput("ev1", "x\n");
    injectPendingNotifications(new ContextManager({ maxTokens: 200_000 }));
    markMainTurnCompleted();
    evictTerminalTasks();

    const mine = events.filter((e) => e.task_id === "ev1");
    expect(mine.map((e) => e.phase)).toEqual(["started", "completed", "delivered", "evicted"]);
    const delivered = mine.find((e) => e.phase === "delivered")!;
    const evicted = mine.find((e) => e.phase === "evicted")!;
    // 验收曲线：evicted 与 delivered 同回合的计数恒为 0
    expect(evicted.turn as number).toBeGreaterThan(delivered.turn as number);
    expect(evicted.reason).toBe("delivered_turn_passed");
    expect(mine.find((e) => e.phase === "completed")!.exit_code).toBe(0);
  });

  test("重复 updateTask 不重复落 completed", () => {
    completedWithOutput("ev2", "x\n");
    updateTask<LocalShellTaskState>("ev2", (t) => ({ ...t, outputOffset: 1 }));
    expect(events.filter((e) => e.task_id === "ev2" && e.phase === "completed")).toHaveLength(1);
  });
});
