/**
 * D1-b 第 1 层：信号退出（SIGTERM / SIGHUP）与 `process.on("exit")` 必须清理 monitor 子进程
 *
 * ## 缺陷形态（20261109 monitor 实测基线）
 *
 * `kill -TERM <sid-code>` 后宿主退出，monitor 子进程 94623 仍存活（PPID=1），events.jsonl 只有
 * `started + WaitRegistered + SessionEnd{abort}`。monitor 是 detached 的进程组组长，`onSignal`
 * 从头到尾不碰任务系统，`process.on("exit")` 只删 PID 文件。
 *
 * ## 这里怎么验
 *
 * 子进程（`exit-signal-kills-monitor-child.ts`）里构造真实 App、注册真实信号处理器、用真实
 * `MonitorTool` 起真实子进程；父进程发**真实信号**，等宿主退出后用 `ps` 按命令行 token 找
 * monitor 进程，并读子进程落的事件流断言顺序。不用 LLM，所以能进常规 `bun test`；
 * `scripts/verify-monitor.ts --case D1b-signal` 是同一条路径的端到端版本（真实二进制 + 模型挂载）。
 *
 * 三条路径分开测：SIGTERM 与 SIGHUP 共用 onSignal，但 SIGHUP 有单独的接管逻辑（关终端 /
 * SSH 断连），只测 TERM 会漏掉「HUP 分支忘了调清理」；`exit` 模式覆盖不经过信号的
 * `process.exit`（无头正常结束 / 预算硬停 / 运行时异常）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHILD = join(import.meta.dir, "exit-signal-kills-monitor-child.ts");
const isWin = process.platform === "win32";
const dirs: string[] = [];
const tokens: string[] = [];

afterEach(() => {
  for (const t of tokens.splice(0)) {
    for (const pid of monitorPids(t)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** monitor 子进程：命令行含 token 且是 `while true` 循环（排除宿主自己——它的 argv 也带 token） */
function monitorPids(token: string): number[] {
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

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

interface Run {
  child: ChildProcess;
  token: string;
  eventsFile: string;
  output: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startChild(mode: "signal" | "exit"): Run {
  const dir = mkdtempSync(join(tmpdir(), "sid-exit-signal-"));
  dirs.push(dir);
  const token = `SIGTOKEN${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  tokens.push(token);
  const eventsFile = join(dir, "events.jsonl");
  // 子进程不继承进程内的 env 改动：SID_CONFIG_DIR 必须显式传（CONTRIBUTING 测试约定第 4 条）
  const child = spawn(process.execPath, [CHILD, mode, token, eventsFile], {
    env: { ...process.env, SID_CONFIG_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout?.on("data", (d) => (buf += String(d)));
  child.stderr?.on("data", (d) => (buf += String(d)));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, token, eventsFile, output: () => buf, exit };
}

function readEvents(file: string): Array<{ event: string; data: Record<string, unknown> }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** 共用断言：宿主退出、monitor 进程消失、终态事件齐全（signal 模式还要求先于 SessionEnd） */
async function assertCleaned(run: Run, expectSessionEnd: boolean): Promise<void> {
  // 宿主退出后给 3s 收敛（SIGKILL 进程组到被 init 回收之间有一点时间）
  expect(await waitFor(() => monitorPids(run.token).length === 0, 3_000)).toBe(true);
  const ev = readEvents(run.eventsFile);
  const started = ev.find((e) => e.event === "TaskLifecycle" && e.data.phase === "started");
  expect(started).toBeDefined();
  const taskId = started!.data.task_id;
  const completed = ev.findIndex(
    (e) =>
      e.event === "TaskLifecycle" &&
      e.data.task_id === taskId &&
      e.data.phase === "completed" &&
      e.data.status === "killed",
  );
  const released = ev.findIndex(
    (e) => e.event === "WaitReleased" && e.data.id === taskId && e.data.reason === "terminal",
  );
  expect(completed).toBeGreaterThanOrEqual(0);
  expect(released).toBeGreaterThanOrEqual(0);
  if (expectSessionEnd) {
    const sessionEnd = ev.findIndex((e) => e.event === "SessionEnd");
    expect(sessionEnd).toBeGreaterThan(completed);
    expect(sessionEnd).toBeGreaterThan(released);
  }
}

async function runSignal(signal: "SIGTERM" | "SIGHUP", expectedCode: number): Promise<void> {
  const run = startChild("signal");
  const ready = await waitFor(() => run.output().includes("READY"), 20_000);
  expect(ready, run.output()).toBe(true);
  // 基线：信号前 monitor 确实在跑（否则「信号后没进程」是空真）
  expect(monitorPids(run.token)).toHaveLength(1);

  run.child.kill(signal);
  const result = await Promise.race([
    run.exit,
    new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
  ]);
  expect(result, `宿主 5s 内未退出\n${run.output()}`).not.toBeNull();
  expect(result!.code).toBe(expectedCode);
  await assertCleaned(run, true);
}

describe.skipIf(isWin)("D1-b：信号退出清理 monitor 子进程", () => {
  test("SIGTERM（外部终止）：宿主退出码 143，monitor 进程组被杀，终态先于 SessionEnd", async () => {
    await runSignal("SIGTERM", 143);
  }, 40_000);

  test("SIGHUP（关终端 / SSH 断连）：宿主退出码 129，monitor 进程组被杀，终态先于 SessionEnd", async () => {
    await runSignal("SIGHUP", 129);
  }, 40_000);
});

describe.skipIf(isWin)('D1：process.on("exit") 最后一道', () => {
  test("不经过信号的 process.exit（无头正常结束 / 预算硬停）也清理 monitor", async () => {
    const run = startChild("exit");
    const result = await Promise.race([
      run.exit,
      new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
    ]);
    expect(result, run.output()).not.toBeNull();
    expect(run.output()).toContain("READY");
    expect(result!.code).toBe(0);
    await assertCleaned(run, false);
  }, 40_000);
});
