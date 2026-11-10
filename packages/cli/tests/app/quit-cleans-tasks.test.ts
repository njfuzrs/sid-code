/**
 * D1：会话退出必须清理后台任务（monitor 子进程）并先于 SessionEnd 落终态
 *
 * ## 缺陷形态（20261109 monitor 实测，会话 20261109-223954-77ece4e5）
 *
 * `/quit` 后 monitor 子进程 86522 存活且 PPID=1（被 launchd 收养），events.jsonl 里该任务
 * 只有 `started`，没有 `completed` / `WaitReleased`。monitor 是 detached 的进程组组长，
 * 宿主退出不会连带杀死它；`killMonitorTask` 的注释写着「会话退出」会调它，实际退出路径
 * 一个调用点都没有。
 *
 * ## 为什么必须从 `case "quit"` 进
 *
 * 前一份方案记录过的教训：直调被提炼出来的清理函数，测试会绿，而分支里漏写调用也照样绿。
 * 所以这里构造真实 App、用真实 `MonitorTool` 起真实子进程，驱动
 * `handleCommandExecutionResult({ type: "quit" })`；变异自证注释的是**分支里的那行调用**。
 *
 * `/quit` 在 `-p` 下不可用（无头会拒绝交互命令），所以这条分支只能由单测锁住；
 * 信号路径与 `process.on("exit")` 由 `exit-signal-kills-monitor.test.ts` 用真实信号覆盖，
 * 端到端由 `scripts/verify-monitor.ts --case D1b-signal` 覆盖。
 *
 * ## 断言口径
 *
 * - 子进程真的没了（`process.kill(pid, 0)` 抛 ESRCH，不是只看 registry 状态）；
 * - `TaskLifecycle{completed, killed}` 与 `WaitReleased{terminal}` 都落了，且**先于 SessionEnd**；
 * - **不**断言 `delivered`：终态通知只是入队，投递要等下一轮，退出路径上进程马上 exit。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { App } from "@sid-code/cli/app.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { MonitorTool } from "@sid-code/core/tool/monitor.ts";
import { __clearActiveMonitorsForTest } from "@sid-code/core/task/monitor-task.ts";
import { clearAllTasks, getTask, registerTask } from "@sid-code/core/task/registry.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";
import { setTaskLifecycleSink } from "@sid-code/core/task/lifecycle.ts";
import { __resetWaitRegistryForTest, setWaitTraceSink } from "@sid-code/core/task/wait-registry.ts";
import type { LocalAgentTaskState } from "@sid-code/core/task/types.ts";

type Captured = { event: string; data: Record<string, unknown> };

const isWin = process.platform === "win32";
let captured: Captured[] = [];
let dir = "";
const prevConfigDir = process.env.SID_CONFIG_DIR;
const realExit = process.exit;
let exitCalls: Array<number | undefined> = [];
/** 本用例是否触发了 /quit 收尾（只有它会在 100ms 后调 process.exit） */
let quitTriggered = false;
let token = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-quit-cleans-tasks-"));
  process.env.SID_CONFIG_DIR = dir;
  captured = [];
  exitCalls = [];
  quitTriggered = false;
  token = `QUITTOKEN${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  __resetWaitRegistryForTest();
  dequeuePendingNotifications();
  setTaskLifecycleSink((data) => captured.push({ event: "TaskLifecycle", data }));
  setWaitTraceSink((event, data) => captured.push({ event, data }));
  // `/quit` 的收尾在 100ms 后 process.exit(0)：不拦住会把整个测试进程带走
  (process as any).exit = (code?: number) => {
    exitCalls.push(code);
  };
});

afterEach(async () => {
  // 先等收尾跑完再还原 process.exit，否则晚到的 exit(0) 会打到真实实现上
  if (quitTriggered) await waitFor(() => exitCalls.length > 0, 3_000);
  (process as any).exit = realExit;
  setTaskLifecycleSink(null);
  setWaitTraceSink(null);
  for (const pid of monitorPids()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  __resetWaitRegistryForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

/** 按命令行里的唯一 token 找 monitor 子进程（不依赖实现内部的 pid 记账） */
function monitorPids(): number[] {
  if (!token) return [];
  try {
    return execSync("ps -Ao pid=,command=")
      .toString()
      .split("\n")
      .filter((l) => l.includes(token) && l.includes("while true"))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: any) {
    return err?.code === "ESRCH";
  }
}

function makeApp(): App {
  const config = {
    ...defaultConfig(),
    model: "mock-model",
    provider: "mock",
    availableModels: [],
  } as unknown as Config;
  const app = new App({
    unifiedRegistry: new UnifiedCommandRegistry(),
    config,
    provider: {} as never,
    mcpManager: {} as never,
  });
  // SessionEnd 打一个标记进同一条事件流：终态事件必须排在它前面
  (app as any).hookSystem.fireSessionEndEvent = async () => {
    captured.push({ event: "SessionEnd", data: {} });
  };
  return app;
}

function quitDeps() {
  const noop = () => {};
  return {
    cmd: "quit",
    commandInput: "/quit",
    callbacks: { onUserInput: async () => {} },
    updateState: noop,
    appendCommandOutput: noop,
    presentCommandResult: noop,
    presentConversationalResult: noop,
    getConversationClearedPatch: () => ({}),
    clearPromptCache: noop,
    resetSyncState: noop,
    rebuildDisplay: noop,
  };
}

/** 用真实 monitor 工具起一个长跑 monitor（含等待登记），返回任务 id 与子进程 pid */
async function startRealMonitor(): Promise<{ taskId: string; pid: number }> {
  const r = await new MonitorTool().call({
    description: "quit 退出清理验收",
    command: `while true; do sleep 1; done # ${token}`,
    timeout_ms: 120_000,
  });
  expect(r.isError).toBeFalsy();
  const taskId = String(r.data).match(/已启动监控 (\S+)（/)?.[1];
  expect(taskId).toBeDefined();
  expect(await waitFor(() => monitorPids().length === 1, 3_000)).toBe(true);
  return { taskId: taskId!, pid: monitorPids()[0]! };
}

/** 驱动 `case "quit"` 分支（真实入口，不直调被提炼的清理方法） */
async function runQuit(app: App, message?: string): Promise<void> {
  quitTriggered = true;
  await (app as any).handleCommandExecutionResult({ type: "quit", message }, quitDeps());
}

function indexOf(pred: (c: Captured) => boolean): number {
  return captured.findIndex(pred);
}

describe.skipIf(isWin)('D1：/quit（case "quit"）清理后台任务', () => {
  test("monitor 子进程被杀，终态 TaskLifecycle{completed,killed} + WaitReleased{terminal} 先于 SessionEnd 落下", async () => {
    const { taskId, pid } = await startRealMonitor();
    const app = makeApp();

    await runQuit(app, "bye");

    // 子进程真的没了（SIGKILL 进程组后由运行时回收，给 2s 收敛）
    expect(await waitFor(() => isDead(pid), 2_000)).toBe(true);
    expect(monitorPids()).toEqual([]);
    expect(getTask(taskId)?.status).toBe("killed");

    const completed = indexOf(
      (c) =>
        c.event === "TaskLifecycle" &&
        c.data.task_id === taskId &&
        c.data.phase === "completed" &&
        c.data.status === "killed",
    );
    const released = indexOf(
      (c) => c.event === "WaitReleased" && c.data.id === taskId && c.data.reason === "terminal",
    );
    // 等收尾跑到 SessionEnd（它在 /quit 的异步收尾里）
    expect(await waitFor(() => indexOf((c) => c.event === "SessionEnd") >= 0, 3_000)).toBe(true);
    const sessionEnd = indexOf((c) => c.event === "SessionEnd");
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(released).toBeGreaterThanOrEqual(0);
    expect(completed).toBeLessThan(sessionEnd);
    expect(released).toBeLessThan(sessionEnd);
    // 不断言 delivered：退出路径上通知没有机会投递
    expect(await waitFor(() => exitCalls.length > 0, 3_000)).toBe(true);
    expect(exitCalls[0]).toBe(0);
  });

  test("元数据随终态删除（下次启动的孤儿扫描不会再碰它）", async () => {
    const { taskId } = await startRealMonitor();
    const metaFile = join(dir, "tasks", `${taskId}.monitor.json`);
    expect(() => readFileSync(metaFile, "utf-8")).not.toThrow();
    const app = makeApp();

    await runQuit(app);

    expect(() => readFileSync(metaFile, "utf-8")).toThrow();
  });

  test("边界：前台子代理（isBackgrounded=false）不被杀——它的中断出口是 ESC", async () => {
    const fg: LocalAgentTaskState = {
      id: "afg-keep",
      type: "local_agent",
      status: "running",
      description: "前台子代理",
      startTime: Date.now(),
      outputFile: "",
      outputOffset: 0,
      notified: false,
      agentId: "agent-fg",
      agentType: "general-purpose",
      prompt: "x",
      isBackgrounded: false,
    };
    registerTask(fg);
    const app = makeApp();

    await runQuit(app);

    expect(getTask("afg-keep")?.status).toBe("running");
  });

  test("边界：没有任何任务时是 no-op，照常退出", async () => {
    const app = makeApp();
    await runQuit(app);
    expect(await waitFor(() => exitCalls.length > 0, 3_000)).toBe(true);
    expect(exitCalls[0]).toBe(0);
    expect(captured.filter((c) => c.event === "TaskLifecycle")).toEqual([]);
  });
});

describe.skipIf(isWin)("D1-b：崩溃兜底 emergencySessionEnd 清理后台任务", () => {
  test("monitor 子进程被杀，终态事件先于 SessionEnd", async () => {
    const { taskId, pid } = await startRealMonitor();
    const app = makeApp();

    // emergencySessionEnd 自己不 exit（由 cli.ts 的全局处理器 exit）
    app.emergencySessionEnd(new Error("boom"));

    expect(await waitFor(() => isDead(pid), 2_000)).toBe(true);
    expect(getTask(taskId)?.status).toBe("killed");
    const completed = indexOf(
      (c) =>
        c.event === "TaskLifecycle" && c.data.task_id === taskId && c.data.phase === "completed",
    );
    const released = indexOf((c) => c.event === "WaitReleased" && c.data.id === taskId);
    const sessionEnd = indexOf((c) => c.event === "SessionEnd");
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(released).toBeGreaterThanOrEqual(0);
    expect(sessionEnd).toBeGreaterThan(completed);
    expect(sessionEnd).toBeGreaterThan(released);
  });
});

/**
 * TUI 正常退出（Ctrl+D / 两次 Ctrl+C）走 runTUI 的尾部，不经过 `/quit` 的 case 分支，
 * 也不是信号（TUI 是 exitOnCtrlC:false）。runTUI 依赖整个 Ink 渲染栈，没有行为层接缝，
 * 这里只做静态接线检查（与 signal-telemetry-drain-wiring.test.ts 同一种写法）。
 */
describe("D1：TUI 正常退出路径的接线", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "src", "app.ts"), "utf-8");

  test('runTUI 尾部：waitUntilExit 之后、SessionEnd("exit") 之前终止后台任务', () => {
    const wait = src.indexOf("await app.waitUntilExit();");
    expect(wait).toBeGreaterThan(0);
    const tail = src.slice(wait, wait + 6_000);
    const kill = tail.indexOf('this.terminateBackgroundTasksOnExit("tui_exit");');
    const sessionEnd = tail.indexOf('fireSessionEndEvent("exit"');
    expect(kill).toBeGreaterThan(0);
    expect(sessionEnd).toBeGreaterThan(kill);
  });

  /**
   * D1-b 第 2 层的启动扫描接线。行为（该杀的杀、不该杀的不杀）在
   * core/tests/task/monitor-orphans.test.ts 用真实进程覆盖；端到端由
   * `verify-monitor --case D1b-sigkill` / `D1b-orphan-scan-negative` 覆盖（需要模型，CI 不跑）。
   * 这里只拦「有人把调用从启动诊断里删掉」。
   */
  test("启动诊断：findOrphanPids 之后调用 reapOrphanMonitors 并写 DIAG 清理日志", () => {
    const pids = src.indexOf("PidManager.findOrphanPids()");
    expect(pids).toBeGreaterThan(0);
    const after = src.slice(pids, pids + 4_000);
    const reap = after.indexOf("const reap = reapOrphanMonitors();");
    expect(reap).toBeGreaterThan(0);
    // verify-monitor 的 findOrphanCleanupLog 按「monitor + 清理/孤儿」匹配这一行
    expect(after.slice(reap)).toContain("个孤儿 monitor 进程组（宿主已退出）");
  });
});
