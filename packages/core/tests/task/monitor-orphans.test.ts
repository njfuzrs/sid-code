/**
 * D1-b 第 2 层：monitor 子进程的孤儿兜底（`packages/core/src/task/monitor-orphans.ts`）
 *
 * 宿主被 SIGKILL / OOM 杀掉时退出清理一行都跑不到，detached 的 monitor 子进程会被
 * launchd 收养永久泄漏。兜底 = spawn 时落元数据、终态时删、下次启动扫描残留。
 *
 * 这里锁三件事：
 *   1. 判据（纯函数 `classifyMonitorMeta`）：宿主活着不动 / 宿主 pid 复用算死 /
 *      进程组身份核对不上不杀 / ps 查不到不杀；
 *   2. 真实进程上的扫描：该杀的真杀掉（进程 exit 事件到达），不该杀的真活着；
 *   3. 元数据的生命周期跟着真实 `spawnMonitorTask` 走：spawn 后在、终态后删。
 *
 * 用真实子进程而不是 mock `process.kill`：「对进程组发 SIGKILL」写成 `kill(pid)` 还是
 * `kill(-pid)`、发没发出去，mock 掉就没有被验证的余地了。
 *
 * 落盘隔离：元数据落 `sidPaths.tasks()`，按 CONTRIBUTING「测试约定」把 SID_CONFIG_DIR
 * 指向 tmpdir（存/恢复原值）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MONITOR_META_SUFFIX,
  classifyMonitorMeta,
  parsePsPgidTable,
  reapOrphanMonitors,
  type MonitorProcessMeta,
  type PsRow,
} from "../../src/task/monitor-orphans.ts";
import {
  __clearActiveMonitorsForTest,
  killAllRunningMonitors,
  killMonitorTask,
  spawnMonitorTask,
} from "../../src/task/monitor-task.ts";
import { clearAllTasks, getTask, registerTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import { sidPaths } from "../../src/config/paths.ts";
import type { LocalShellTaskState } from "../../src/task/types.ts";

const isWin = process.platform === "win32";

let originalConfigDir: string | undefined;
let tmpHome = "";
const spawned: ChildProcess[] = [];

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-monitor-orphans-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  dequeuePendingNotifications();
});

afterEach(() => {
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  for (const c of spawned.splice(0)) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

// ─────────────────────────── 工具 ───────────────────────────

/** 起一个 detached 的长跑进程组（模拟 monitor 子进程：组长 pid 即 pgid） */
function spawnGroup(): { child: ChildProcess; pid: number; exited: Promise<boolean> } {
  const child = spawn("/bin/sh", ["-c", "sleep 300"], { detached: true, stdio: "ignore" });
  spawned.push(child);
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  return { child, pid: child.pid!, exited };
}

/** 一个已经退出的 pid（模拟「宿主已被 SIGKILL」） */
async function deadPid(): Promise<number> {
  const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  return child.pid!;
}

/** 等 promise 在 timeoutMs 内兑现；超时返回 false（用于「进程应当被杀 / 不应被杀」） */
async function within(p: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
}

function writeMeta(meta: Partial<MonitorProcessMeta> & { task_id: string }): string {
  const dir = sidPaths.tasks();
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const full: MonitorProcessMeta = {
    version: 1,
    pgid: 999_999,
    spawned_at: now,
    host_pid: process.pid,
    host_recorded_at: now,
    command: "tail -F x",
    ...meta,
  };
  const file = join(dir, `${meta.task_id}${MONITOR_META_SUFFIX}`);
  writeFileSync(file, JSON.stringify(full));
  return file;
}

const T0 = Date.parse("2026-11-10T08:00:00.000Z");
function meta(over: Partial<MonitorProcessMeta> = {}): MonitorProcessMeta {
  return {
    version: 1,
    task_id: "mtest",
    pgid: 500,
    spawned_at: new Date(T0).toISOString(),
    host_pid: 400,
    host_recorded_at: new Date(T0).toISOString(),
    command: "tail -F x",
    ...over,
  };
}
const dead = () => false;
const alive = () => true;

// ─────────────────────────── 1. 解析 ───────────────────────────

describe("parsePsPgidTable", () => {
  test("解析 TZ=UTC 的 lstart（含空格对齐的日期与行尾空白），丢弃无法解析的行", () => {
    const out = [
      "    1     1 Tue Nov 10 02:05:19 2026    ",
      "  501   500 Mon Nov  2 08:00:01 2026",
      "garbage line",
      "",
    ].join("\n");
    const rows = parsePsPgidTable(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ pid: 1, pgid: 1, startMs: Date.parse("2026-11-10T02:05:19Z") });
    expect(rows[1]!.pid).toBe(501);
    expect(rows[1]!.pgid).toBe(500);
    expect(rows[1]!.startMs).toBe(Date.parse("2026-11-02T08:00:01Z"));
  });
});

// ─────────────────────────── 2. 判据 ───────────────────────────

describe("classifyMonitorMeta 判据", () => {
  const leader: PsRow = { pid: 500, pgid: 500, startMs: T0 - 1_000 };

  test("宿主还活着 → 不动（多开会话共享配置根，最容易写错的地方）", () => {
    expect(classifyMonitorMeta(meta(), [leader], alive)).toEqual({
      action: "keep",
      reason: "host_alive",
    });
  });

  test("宿主 pid 活着但启动晚于记录时刻 → pid 已被复用，原宿主已死 → 清理", () => {
    const reusedHost: PsRow = { pid: 400, pgid: 400, startMs: T0 + 3_600_000 };
    expect(classifyMonitorMeta(meta(), [reusedHost, leader], alive)).toEqual({
      action: "reap",
      members: [500],
    });
  });

  test("宿主 pid 活着且启动不晚于记录时刻 → 仍是原宿主 → 不动", () => {
    const sameHost: PsRow = { pid: 400, pgid: 400, startMs: T0 - 60_000 };
    expect(classifyMonitorMeta(meta(), [sameHost, leader], alive).action).toBe("keep");
  });

  test("宿主已死、ps 不可用 → 不杀，留到下次启动（宁可漏清，不可误杀）", () => {
    expect(classifyMonitorMeta(meta(), null, dead)).toEqual({
      action: "keep",
      reason: "ps_unavailable",
    });
  });

  test("宿主已死、进程组已不存在 → 只删元数据", () => {
    expect(classifyMonitorMeta(meta(), [{ pid: 1, pgid: 1, startMs: T0 }], dead)).toEqual({
      action: "drop",
      reason: "group_gone",
    });
  });

  test("宿主已死、组内成员全部启动晚于 spawn → pgid 被复用，不杀", () => {
    const reused: PsRow = { pid: 500, pgid: 500, startMs: T0 + 60_000 };
    expect(classifyMonitorMeta(meta(), [reused], dead)).toEqual({
      action: "drop",
      reason: "identity_mismatch",
    });
  });

  test("秒级截断容差：组长 lstart 比 spawn 晚不到容差 → 仍认是同一进程组", () => {
    const truncated: PsRow = { pid: 500, pgid: 500, startMs: T0 + 1_500 };
    expect(classifyMonitorMeta(meta(), [truncated], dead).action).toBe("reap");
  });

  test("宿主已死、组长启动于 spawn 之前 → 清理整个组（含后来 fork 的孙进程）", () => {
    const grandchild: PsRow = { pid: 777, pgid: 500, startMs: T0 + 600_000 };
    expect(classifyMonitorMeta(meta(), [leader, grandchild], dead)).toEqual({
      action: "reap",
      members: [500, 777],
    });
  });

  test("组内成员都解析不出启动时刻 → 按查不到处理，不杀", () => {
    const untimed: PsRow = { pid: 500, pgid: 500, startMs: Number.NaN };
    expect(classifyMonitorMeta(meta(), [untimed], dead)).toEqual({
      action: "keep",
      reason: "ps_unavailable",
    });
  });
});

// ─────────────────────────── 3. 真实进程上的扫描 ───────────────────────────

describe.skipIf(isWin)("reapOrphanMonitors（真实进程）", () => {
  test("宿主已死 + 身份核对通过 → 进程组被 SIGKILL，元数据删除，报告里有它", async () => {
    const g = spawnGroup();
    const hostPid = await deadPid();
    const file = writeMeta({ task_id: "morphan1", pgid: g.pid, host_pid: hostPid });

    const report = reapOrphanMonitors();

    expect(await within(g.exited, 3_000)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(report.reaped.map((r) => r.meta.task_id)).toEqual(["morphan1"]);
    expect(report.reaped[0]!.members).toContain(g.pid);
  });

  test("反向：宿主还活着（本测试进程）→ 进程组不动、元数据保留", async () => {
    const g = spawnGroup();
    const file = writeMeta({ task_id: "malive1", pgid: g.pid, host_pid: process.pid });

    const report = reapOrphanMonitors();

    expect(await within(g.exited, 800)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(report.kept).toEqual([{ taskId: "malive1", reason: "host_alive" }]);
    expect(report.reaped).toEqual([]);
  });

  test("反向：pgid 被复用（记录的 spawn 时刻远早于真实进程启动）→ 不杀，只删元数据", async () => {
    const g = spawnGroup();
    const hostPid = await deadPid();
    const file = writeMeta({
      task_id: "mreused1",
      pgid: g.pid,
      host_pid: hostPid,
      spawned_at: new Date(Date.now() - 3_600_000).toISOString(),
    });

    const report = reapOrphanMonitors();

    expect(await within(g.exited, 800)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(report.dropped).toEqual([{ taskId: "mreused1", reason: "identity_mismatch" }]);
  });

  test("宿主已死、进程组早已退出 → 只删元数据", async () => {
    const goneGroup = await deadPid();
    const hostPid = await deadPid();
    const file = writeMeta({ task_id: "mgone1", pgid: goneGroup, host_pid: hostPid });

    const report = reapOrphanMonitors();

    expect(existsSync(file)).toBe(false);
    expect(report.dropped).toEqual([{ taskId: "mgone1", reason: "group_gone" }]);
  });

  test("损坏的元数据 → 删除、不 kill；目录里的其他文件（.output）不碰", () => {
    const dir = sidPaths.tasks();
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, `mbad1${MONITOR_META_SUFFIX}`);
    writeFileSync(bad, "{not json");
    const output = join(dir, "mbad1.output");
    writeFileSync(output, "keep me");

    const report = reapOrphanMonitors();

    expect(existsSync(bad)).toBe(false);
    expect(readFileSync(output, "utf-8")).toBe("keep me");
    expect(report.dropped).toEqual([{ taskId: "mbad1", reason: "corrupt" }]);
  });

  test("没有元数据文件时不起 ps（不给每次启动加开销）", () => {
    mkdirSync(sidPaths.tasks(), { recursive: true });
    writeFileSync(join(sidPaths.tasks(), "x.output"), "");
    let psCalls = 0;
    const report = reapOrphanMonitors({
      psTable: () => {
        psCalls++;
        return null;
      },
    });
    expect(psCalls).toBe(0);
    expect(report).toEqual({ reaped: [], dropped: [], kept: [] });
  });
});

// ─────────────────────────── 4. 元数据跟着真实 monitor 走 ───────────────────────────

function metaFileOf(taskId: string): string {
  return join(sidPaths.tasks(), `${taskId}${MONITOR_META_SUFFIX}`);
}

describe.skipIf(isWin)("spawnMonitorTask 的元数据生命周期", () => {
  test("spawn 后落元数据（宿主 = 本进程，pgid = 子进程 pid）；task_stop 路径终态后删除", () => {
    const task = spawnMonitorTask({
      description: "orphan meta",
      command: "sleep 30",
      timeoutMs: 60_000,
      cwd: tmpHome,
    });
    const file = metaFileOf(task.id);
    expect(existsSync(file)).toBe(true);
    const m = JSON.parse(readFileSync(file, "utf-8")) as MonitorProcessMeta;
    expect(m.task_id).toBe(task.id);
    expect(m.host_pid).toBe(process.pid);
    expect(Number.isInteger(m.pgid) && m.pgid > 1).toBe(true);
    expect(Date.parse(m.spawned_at)).toBeGreaterThan(0);

    killMonitorTask(task.id);
    expect(existsSync(file)).toBe(false);
  });

  test("脚本自然结束 → 终态后元数据删除", async () => {
    const task = spawnMonitorTask({
      description: "natural exit",
      command: "true",
      timeoutMs: 60_000,
      cwd: tmpHome,
    });
    const file = metaFileOf(task.id);
    const start = Date.now();
    while (Date.now() - start < 3_000 && getTask(task.id)?.status === "running") {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getTask(task.id)?.status).toBe("completed");
    expect(existsSync(file)).toBe(false);
  });

  test("刚 spawn 的 monitor 被本进程自己的启动扫描看到时 → 宿主活着，不动", async () => {
    const task = spawnMonitorTask({
      description: "self",
      command: "sleep 30",
      timeoutMs: 60_000,
      cwd: tmpHome,
    });
    const report = reapOrphanMonitors();
    expect(report.kept).toEqual([{ taskId: task.id, reason: "host_alive" }]);
    expect(getTask(task.id)?.status).toBe("running");
  });
});

// ─────────────────────────── 5. killAllRunningMonitors ───────────────────────────

describe.skipIf(isWin)("killAllRunningMonitors（process.on('exit') 的最后一道）", () => {
  test("只杀 monitor，不碰后台 shell（无头正常结束时它多半是有意留下的常驻服务）", () => {
    const m1 = spawnMonitorTask({
      description: "a",
      command: "sleep 30",
      timeoutMs: 60_000,
      cwd: tmpHome,
    });
    const m2 = spawnMonitorTask({
      description: "b",
      command: "sleep 30",
      timeoutMs: 60_000,
      cwd: tmpHome,
    });
    const shell: LocalShellTaskState = {
      id: "bshell-keep",
      type: "local_shell",
      status: "running",
      description: "dev server",
      startTime: Date.now(),
      outputFile: "",
      outputOffset: 0,
      notified: false,
      command: "bun run dev",
      interrupted: false,
      isBackgrounded: true,
    };
    registerTask(shell);

    expect(killAllRunningMonitors()).toBe(2);

    expect(getTask(m1.id)?.status).toBe("killed");
    expect(getTask(m2.id)?.status).toBe("killed");
    expect(getTask("bshell-keep")?.status).toBe("running");
    expect(existsSync(metaFileOf(m1.id))).toBe(false);
    expect(existsSync(metaFileOf(m2.id))).toBe(false);
  });
});
