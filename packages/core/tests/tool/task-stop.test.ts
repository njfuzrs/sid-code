/**
 * TaskStopTool 真实入口回归（D1）
 *
 * 背景：`task_stop` 的分派原先只有 shell / agent / workflow 三支，monitor 落空后
 * 照样走到写死的 `status: "killed"`——模型以为停了，进程其实还在跑（review 文档
 * 20261109 的 D1 / 复现 R6）。D1 的成因正是旧测试直调 `killMonitorTask` 绕过了
 * 真实入口，所以这里的用例一律从 `new TaskStopTool().execute()` 进。
 *
 * 落盘隔离：monitor / shell / agent / workflow 都会 initTaskOutput 写
 * `~/.sid-code/tasks/`，按 CONTRIBUTING「测试约定」把 SID_CONFIG_DIR 指向 tmpdir
 * （存/恢复原值，不要无条件 delete——会抹掉 bunfig preload 的兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { platform } from "os";
import { TaskStopTool } from "../../src/tool/task-stop.ts";
import { __clearActiveMonitorsForTest, spawnMonitorTask } from "../../src/task/monitor-task.ts";
import { spawnShellTask } from "../../src/task/shell-task.ts";
import { createAgentTask } from "../../src/task/agent-task.ts";
import { createWorkflowTask } from "../../src/task/workflow-task.ts";
import { clearAllTasks, getTask, registerTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import { isTerminalStatus, type TaskState, type TaskType } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-task-stop-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  dequeuePendingNotifications(); // 清掉前面用例的残留通知
});

afterEach(() => {
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 轮询等待条件成立（bun 默认 5s 单测超时，这里留足余量但不等满） */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

/** 进程组是否还活着（ESRCH = 整组都没了） */
function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 取走当前全部通知的结构化快照 */
function takeNotifications() {
  return dequeuePendingNotifications().map((n) => n.structured!);
}

/**
 * 任务类型清单。新增 `TaskType` 时这里必须跟着加：
 * 下面 `TASK_TYPE_FACTORIES` 的 `Record<TaskType, …>` 标注会在 tsc 阶段报缺属性，
 * 运行时穷举用例也会因为新类型没有工厂而拿不到任务 → 红。
 */
const ALL_TASK_TYPES = [
  "local_shell",
  "local_agent",
  "local_workflow",
  "local_monitor",
] as const satisfies readonly TaskType[];

/** 每种类型用**真实构造路径**各起一个 running 任务（不用手搓 TaskState，避免漏字段） */
function startRunningTask(type: TaskType): TaskState {
  switch (type) {
    case "local_shell":
      return spawnShellTask({ command: "sleep 60", cwd: tmpHome });
    case "local_agent":
      return createAgentTask({
        agentType: "general-purpose",
        prompt: "测试任务",
        description: "测试 agent",
      }).taskState;
    case "local_workflow":
      return createWorkflowTask({
        workflowName: "test-workflow",
        runId: "wf_test",
        source: "inline",
        description: "测试 workflow",
      }).taskState;
    case "local_monitor":
      return spawnMonitorTask({
        description: "测试 monitor",
        command: "sleep 60",
        timeoutMs: 10_000,
        cwd: tmpHome,
      });
  }
}

describe("task_stop 对 monitor 生效（D1）", () => {
  test.skipIf(platform() === "win32")(
    "monitor 被 task_stop 终止：状态 killed、进程组不再活、终态通知只一条且写明 task_stop",
    async () => {
      // 脚本先把 pid 打到 stdout（monitor 会把它变成事件通知），再常驻。
      // pid 是进程组组长（spawn 时 detached: true），kill(-pid) 清整棵树。
      const task = spawnMonitorTask({
        description: "CI",
        command: 'echo "pid=$$"; sleep 60',
        timeoutMs: 20_000,
        cwd: tmpHome,
      });

      const firstBatch = await waitFor(() => {
        const notes = takeNotifications();
        const event = notes.find((n) => n.event !== undefined)?.event;
        return event === undefined ? undefined : { event };
      });
      const pid = Number(/pid=(\d+)/.exec(firstBatch.event)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(isProcessGroupAlive(pid)).toBe(true);

      // —— 真实入口：模型就是这么调的 ——
      const result = await new TaskStopTool().execute({ task_id: task.id });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      const payload = JSON.parse(result.output) as { task_id: string; status: string };
      expect(payload.task_id).toBe(task.id);
      expect(payload.status).toBe("killed");
      expect(getTask(task.id)!.status).toBe("killed");

      // 进程组真的没了，不是只在状态里写 killed
      await waitFor(() => (isProcessGroupAlive(pid) ? undefined : true));

      // 终态通知只入队一条（close 回调不许再发一条），文案要说明是 task_stop 停的：
      // 模型看到「到期」会以为期限到了而重新挂一个同样的 monitor。
      const terminal = takeNotifications().filter((n) => n.taskId === task.id);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.status).toBe("killed");
      expect(terminal[0]!.summary).toContain("task_stop");
    },
  );

  test.skipIf(platform() === "win32")(
    "穷举：TaskState 里每个类型都能被 task_stop 终止（新增类型漏分派时这条红）",
    async () => {
      // 标注是 Record<TaskType, …>：新增任务类型没进 ALL_TASK_TYPES 时 tsc 直接报错。
      // 运行时这里按 ALL_TASK_TYPES 逐个构造，分派漏了就会落进兜底分支 → isError。
      const covered: Record<TaskType, true> = {
        local_shell: true,
        local_agent: true,
        local_workflow: true,
        local_monitor: true,
      };
      expect(new Set<string>(ALL_TASK_TYPES)).toEqual(new Set(Object.keys(covered)));

      for (const type of ALL_TASK_TYPES) {
        const task = startRunningTask(type);
        expect(getTask(task.id)!.status).toBe("running");

        const result = await new TaskStopTool().execute({ task_id: task.id });
        expect({ type, isError: (result as { isError?: boolean }).isError }).toEqual({
          type,
          isError: undefined,
        });

        const after = getTask(task.id)!;
        expect({ type, terminal: isTerminalStatus(after.status) }).toEqual({
          type,
          terminal: true,
        });
        // 返回值里的 status 必须从 registry 实读，与事实一致
        const payload = JSON.parse(result.output) as { status: string };
        expect({ type, reported: payload.status }).toEqual({ type, reported: after.status });
      }
    },
  );

  test("兜底分支：未分派的任务类型返回错误，不再假装「已终止」", async () => {
    // 造一个当前分派表不认识的类型（模拟「以后新增任务类型但漏了 task-stop 分支」）。
    // TaskState 联合是闭集，这里显式绕过类型检查，测的正是兜底那一步。
    registerTask({
      id: "x-future",
      type: "local_future",
      status: "running",
      description: "未来类型",
      startTime: Date.now(),
      outputFile: join(tmpHome, "future.out"),
      outputOffset: 0,
      notified: false,
      isBackgrounded: true,
    } as unknown as TaskState);

    const result = await new TaskStopTool().execute({ task_id: "x-future" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.output).toContain("不支持终止该类型任务");
    expect(result.output).toContain("local_future");
    // 关键：任务状态没被改成 killed（不会再出现「回报已终止、实际还在跑」）
    expect(getTask("x-future")!.status).toBe("running");
  });
});
