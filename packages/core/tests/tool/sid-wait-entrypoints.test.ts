/**
 * R7：bash / monitor 两个入口必须真的接管 `sid-wait gh-pr <n>`。
 *
 * 这一层测的**不是轮询逻辑**（那在 `tests/task/sid-wait-gh-pr.test.ts`），而是三件接线：
 *
 * 1. 命中原语时不 spawn 外部进程，任务形态仍是 `local_shell` / `local_monitor`；
 * 2. 等待表里登记的对象是 `gh:pr:<n>`、承诺是 deadline（R1/R2/R6/P1 全都靠它）；
 * 3. 退出码 → 任务终态 + 通知文案（「检查失败」不是「命令执行失败」）。
 *
 * gh 客户端是注入的：入口测试不该真的 spawn `gh`（会打网络、依赖登录态与 cwd 的仓库）。
 *
 * 落盘隔离：内置任务仍会 `initTaskOutput` 写 `~/.sid-code/tasks/`，把 SID_CONFIG_DIR
 * 指向 tmpdir（存/恢复原值，见 CONTRIBUTING 的测试约定）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BashTool } from "../../src/tool/bash.ts";
import { MonitorTool } from "../../src/tool/monitor.ts";
import {
  setSidWaitClientFactoryForTest,
  __resetManualLoopHintForTest,
  type GhRestClient,
  type GhPullSnapshot,
} from "../../src/task/sid-wait.ts";
import { __resetWaitRegistryForTest, listWaits } from "../../src/task/wait-registry.ts";
import { clearAllTasks, getTask } from "../../src/task/registry.ts";
import { __resetBackgroundAwaitForTest } from "../../src/task/background-await.ts";
import { killShellTask } from "../../src/task/shell-task.ts";
import { killMonitorTask, __clearActiveMonitorsForTest } from "../../src/task/monitor-task.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import type { LocalMonitorTaskState, LocalShellTaskState } from "../../src/task/types.ts";

const HEAD = "cccc3333cccc3333cccc3333cccc3333cccc3333";

let originalConfigDir: string | undefined;
let tmpHome = "";
let pullCursor = 0;
let pullQueue: GhPullSnapshot[] = [];
let checkCalls = 0;

function openPull(): GhPullSnapshot {
  return { state: "open", merged: false, headSha: HEAD, mergeableState: "blocked" };
}

function mergedPull(): GhPullSnapshot {
  return { state: "closed", merged: true, headSha: HEAD, mergeableState: null };
}

/** 装上假客户端：按 pullQueue 顺序返回，最后一项重复（模拟状态不变） */
function installClient(pulls: GhPullSnapshot[]): void {
  pullQueue = pulls;
  pullCursor = 0;
  checkCalls = 0;
  setSidWaitClientFactoryForTest((): GhRestClient => ({
    async getPull() {
      const item = pullQueue[Math.min(pullCursor, pullQueue.length - 1)]!;
      pullCursor += 1;
      return item;
    },
    async getCheckRuns() {
      checkCalls += 1;
      return { checkRuns: [] };
    },
  }));
}

/** 让内置任务的微任务跑完（第一次查询是同步链，不需要真的等 30s） */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wait-entry-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  __resetManualLoopHintForTest();
  __clearActiveMonitorsForTest?.();
  clearAllTasks();
  dequeuePendingNotifications();
  setSidWaitClientFactoryForTest(null);
});

afterEach(() => {
  setSidWaitClientFactoryForTest(null);
  __clearActiveMonitorsForTest?.();
  clearAllTasks();
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  dequeuePendingNotifications();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("R7 bash 入口：sid-wait 走内置任务", () => {
  test("后台执行 → local_shell 任务 + 等待表登记 gh:pr:779 + 默认 1800s 期限", async () => {
    installClient([openPull()]);
    const tool = new BashTool();
    const result = await tool.execute({
      command: "sid-wait gh-pr 779",
      run_in_background: true,
    });
    const parsed = JSON.parse(result.output) as { task_id: string; message: string };

    expect(result.isError).toBeFalsy();
    // 回执要说清这是内置原语（否则模型会以为自己起了一个 shell 脚本）
    expect(parsed.message).toContain("内置等待原语");
    expect(parsed.message).toContain("PR #779");
    expect(parsed.message).toContain("合并 exit 0 / 检查失败 exit 1");

    const task = getTask(parsed.task_id) as LocalShellTaskState;
    expect(task.type).toBe("local_shell");
    expect(task.command).toBe("sid-wait gh-pr 779");

    const wait = listWaits().find((w) => w.id === parsed.task_id);
    expect(wait?.promise.kind).toBe("deadline");
    expect(wait?.subjects).toEqual(["gh:pr:779"]);
    // 没传 wait_until_seconds 也要有期限：否则静默 60s 就被判「不会回报」
    const deadlineIn = wait?.promise.kind === "deadline" ? wait.promise.deadlineAt - Date.now() : 0;
    expect(deadlineIn).toBeGreaterThan(1_700_000);
    expect(deadlineIn).toBeLessThanOrEqual(1_800_000);

    killShellTask(parsed.task_id);
  });

  test("PR 合并 → 任务完成，.output 里是 MERGED，通知写「已合并」", async () => {
    installClient([mergedPull()]);
    const tool = new BashTool();
    const result = await tool.execute({
      command: "sid-wait gh-pr 779",
      run_in_background: true,
    });
    const parsed = JSON.parse(result.output) as { task_id: string; output_file: string };
    await flush();

    const task = getTask(parsed.task_id) as LocalShellTaskState;
    expect(task.status).toBe("completed");
    expect(task.exitCode).toBe(0);
    const output = readFileSync(parsed.output_file, "utf8");
    expect(output).toContain(`MERGED ${HEAD}`);

    const notes = dequeuePendingNotifications();
    const done = notes.find(
      (n) => n.structured?.taskId === parsed.task_id && n.structured.status === "completed",
    );
    expect(done?.structured?.summary).toContain("PR #779 已合并");
  });

  test("检查失败 → 任务失败但文案说「有检查失败」，不是「命令执行失败」", async () => {
    installClient([openPull()]);
    // 让 getCheckRuns 返回一条 failure
    setSidWaitClientFactoryForTest((): GhRestClient => ({
      async getPull() {
        return openPull();
      },
      async getCheckRuns() {
        return {
          checkRuns: [
            { name: "test (macos-latest, 2/2)", status: "completed", conclusion: "failure", id: 7 },
          ],
        };
      },
    }));
    const tool = new BashTool();
    const result = await tool.execute({
      command: "sid-wait gh-pr 780",
      run_in_background: true,
    });
    const parsed = JSON.parse(result.output) as { task_id: string; output_file: string };
    await flush();

    const task = getTask(parsed.task_id) as LocalShellTaskState;
    expect(task.status).toBe("failed");
    expect(task.exitCode).toBe(1);
    expect(readFileSync(parsed.output_file, "utf8")).toContain(
      "CHECK_FAILED test (macos-latest, 2/2) (failure) job=7",
    );
    const notes = dequeuePendingNotifications();
    const done = notes.find(
      (n) => n.structured?.taskId === parsed.task_id && n.structured.status === "failed",
    );
    expect(done?.structured?.summary).toContain("test (macos-latest, 2/2)(failure)");
  });

  test("前台执行 sid-wait → 明确提示要后台，而不是 command not found", async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: "sid-wait gh-pr 779" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("只能后台执行");
    expect(result.output).toContain("run_in_background=true");
    expect(result.output).toContain("PR #779");
  });

  test("手写 PR 轮询循环 → 回执提示一次内置写法，第二次不再提示", async () => {
    installClient([openPull()]);
    const tool = new BashTool();
    // 用 echo + sleep 而不是真跑 gh：这里只验证 subject 抽取与提示接线
    const first = await tool.execute({
      command: 'echo "PR #779"; sleep 30',
      run_in_background: true,
      wait_until_seconds: 60,
    });
    const firstParsed = JSON.parse(first.output) as { task_id: string; message: string };
    expect(firstParsed.message).toContain("sid-wait gh-pr 779");
    killShellTask(firstParsed.task_id);

    const second = await tool.execute({
      command: 'echo "PR #779"; sleep 30',
      run_in_background: true,
      wait_until_seconds: 60,
    });
    const secondParsed = JSON.parse(second.output) as { task_id: string; message: string };
    expect(secondParsed.message).not.toContain("sid-wait gh-pr 779");
    killShellTask(secondParsed.task_id);
  });
});

describe("R7 monitor 入口：sid-wait 走内置监控", () => {
  test("启动 → local_monitor 任务 + 等待表登记 gh:pr:780 + 回执说明内置原语", async () => {
    installClient([openPull()]);
    const tool = new MonitorTool();
    const result = await tool.call({
      description: "PR #780 CI",
      command: "sid-wait gh-pr 780",
      timeout_ms: 60_000,
    });
    expect(result.isError).toBeFalsy();
    expect(result.data).toContain("内置等待原语");
    expect(result.data).toContain("PR #780");

    const wait = listWaits().find((w) => w.kind === "monitor");
    expect(wait?.subjects).toEqual(["gh:pr:780"]);
    const task = getTask(wait!.id) as LocalMonitorTaskState;
    expect(task.type).toBe("local_monitor");
    expect(task.deadlineAt - task.startTime).toBeGreaterThan(59_000);
    killMonitorTask(task.id);
  });

  test("合并 → 监控完成，事件里有 MERGED，终态通知写「已合并」", async () => {
    installClient([mergedPull()]);
    const tool = new MonitorTool();
    const result = await tool.call({
      description: "PR #780 CI",
      command: "sid-wait gh-pr 780",
      timeout_ms: 60_000,
    });
    const wait = listWaits().find((w) => w.kind === "monitor");
    const taskId = wait!.id;
    await flush();

    const task = getTask(taskId) as LocalMonitorTaskState;
    expect(task.status).toBe("completed");

    const notes = dequeuePendingNotifications();
    expect(
      notes.some(
        (n) => n.structured?.taskId === taskId && n.structured.event?.includes(`MERGED ${HEAD}`),
      ),
    ).toBe(true);
    expect(
      notes.some(
        (n) =>
          n.structured?.taskId === taskId &&
          n.structured.status === "completed" &&
          n.structured.summary.includes("已合并"),
      ),
    ).toBe(true);
    expect(getTask(taskId)).toBeDefined();
    void result;
  });

  test("killMonitorTask 能停掉内置轮询（不再打 REST）", async () => {
    installClient([openPull()]);
    const tool = new MonitorTool();
    await tool.call({
      description: "PR #781 CI",
      command: "sid-wait gh-pr 781",
      timeout_ms: 60_000,
    });
    const wait = listWaits().find((w) => w.kind === "monitor");
    const taskId = wait!.id;
    await flush();
    const callsBeforeKill = checkCalls;
    killMonitorTask(taskId);
    await flush();

    expect((getTask(taskId) as LocalMonitorTaskState).status).toBe("killed");
    // kill 之后最多再多一次进行中的查询（REST 无法中途打断），但不会继续下一轮
    expect(checkCalls - callsBeforeKill).toBeLessThanOrEqual(1);
  });
});
