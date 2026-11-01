/**
 * 启动维护子进程（PR-B）的接线测试。
 *
 * 这条测的不是各清理判据本身（它们各有专门的测试），而是「搬家之后还接着线」：
 *   - 三个任务都真的被 runner 调到、删到该删的东西
 *   - 水位线：跑完刷新，未到期不再跑；全部未到期时 launcher 判出空任务（不 fork）
 *   - 单实例锁：已有存活持有者时整轮跳过
 *   - 会话删除结论写进结果文件、下一次启动只提示一次
 *   - 真实子进程路径：`bootstrap.ts __maintenance <payload>` 能跑完并落结果
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { runMaintenance, type MaintenancePayload } from "@sid-code/core/maintenance/runner.ts";
import {
  consumeSessionCleanupNotice,
  isTaskDue,
  readMaintenanceResult,
} from "@sid-code/core/maintenance/state.ts";
import { dueMaintenanceTasks } from "@sid-code/core/maintenance/launcher.ts";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sid-maint-"));
  prev = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prev;
  rmSync(home, { recursive: true, force: true });
});

const OLD = new Date(Date.UTC(2024, 0, 1));

/** 一个 400 天前的正常会话（过 maxAge=365d） */
function makeExpiredSession(id: string): string {
  const dir = join(sidPaths.sessions(), "proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const t = OLD.toISOString();
  writeFileSync(
    file,
    [
      { type: "session_start", sessionId: id, model: "m", provider: "p", cwd: "/", timestamp: t },
      { type: "user_message", message: { role: "user", content: "hi" }, timestamp: t },
      { type: "assistant_message", message: { role: "assistant", content: "yo" }, timestamp: t },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  utimesSync(file, OLD, OLD);
  return file;
}

/** 一个 30h 前的完全空轨迹目录（P2-11 空目录分支会删） */
function makeEmptyTraceDir(id: string): string {
  const dir = join(sidPaths.trajectories(), "sessions", id);
  mkdirSync(dir, { recursive: true });
  const t = new Date(Date.now() - 30 * 3600_000);
  utimesSync(dir, t, t);
  return dir;
}

function payload(over: Partial<MaintenancePayload> = {}): MaintenancePayload {
  return {
    tasks: ["session-cleanup", "trace-prune", "housekeeping"],
    retention: { enabled: true, maxAge: "365d", minRetention: "1d", maxTotalSize: "10GB" },
    selfSessionId: "self",
    traceOutputDir: sidPaths.trajectories(),
    ...over,
  };
}

describe("runMaintenance 接线", () => {
  test("三个任务都执行：过期会话被删、空轨迹目录被删、管家水位线写入", async () => {
    const session = makeExpiredSession("20240101-000000-aaaaaaaa");
    const trace = makeEmptyTraceDir("ghost");

    const r = await runMaintenance(payload());

    expect(r).not.toBeNull();
    expect(existsSync(session)).toBe(false);
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(sidPaths.lastCleanup())).toBe(true);
    expect(r!.tasks["session-cleanup"]?.ok).toBe(true);
    expect(r!.tasks["trace-prune"]?.ok).toBe(true);
    expect(r!.tasks.housekeeping?.ok).toBe(true);
    expect(r!.sessionCleanup?.deleted).toBe(1);
    // 锁已释放
    expect(existsSync(sidPaths.stateFile("maintenance.lock"))).toBe(false);
  });

  test("D3：受保护的被恢复会话不删", async () => {
    const id = "20240101-000000-bbbbbbbb";
    const session = makeExpiredSession(id);
    await runMaintenance(payload({ tasks: ["session-cleanup"], protectedSessionIds: [id] }));
    expect(existsSync(session)).toBe(true);
  });

  test("水位线：跑完后各任务不再到期；launcher 判出空任务（不 fork）", async () => {
    expect(isTaskDue("session-cleanup")).toBe(true);
    expect(await dueMaintenanceTasks({ sessionCleanup: true })).toEqual([
      "session-cleanup",
      "trace-prune",
      "housekeeping",
    ]);
    await runMaintenance(payload());
    expect(isTaskDue("session-cleanup")).toBe(false);
    expect(isTaskDue("trace-prune")).toBe(false);
    expect(await dueMaintenanceTasks({ sessionCleanup: true })).toEqual([]);
    // 25h 之后又到期
    const later = Date.now() + 25 * 3600_000;
    expect(await dueMaintenanceTasks({ sessionCleanup: true }, later)).toHaveLength(3);
  });

  test("-p 语义：sessionCleanup=false 时不排会话清理", async () => {
    expect(await dueMaintenanceTasks({ sessionCleanup: false })).not.toContain("session-cleanup");
  });

  test("单实例锁：存活持有者在场时整轮跳过，什么都不删", async () => {
    const session = makeExpiredSession("20240101-000000-cccccccc");
    mkdirSync(join(home, "state"), { recursive: true });
    // 用本测试进程自己的 pid 冒充「另一个活着的维护进程」
    writeFileSync(
      sidPaths.stateFile("maintenance.lock"),
      JSON.stringify({ pid: process.ppid, startedAt: Date.now() }),
    );
    const r = await runMaintenance(payload());
    expect(r).toBeNull();
    expect(existsSync(session)).toBe(true);
  });

  test("stale 锁（持有者已死）被回收", async () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(
      sidPaths.stateFile("maintenance.lock"),
      JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 0 }),
    );
    const r = await runMaintenance(payload({ tasks: ["trace-prune"] }));
    expect(r).not.toBeNull();
  });

  test("删除结论只提示一次（删用户数据必须让人看见，但不重复刷屏）", async () => {
    makeExpiredSession("20240101-000000-dddddddd");
    await runMaintenance(payload({ tasks: ["session-cleanup"] }));
    expect(consumeSessionCleanupNotice()?.deleted).toBe(1);
    expect(consumeSessionCleanupNotice()).toBeNull();
    // 其余诊断字段保留
    expect(readMaintenanceResult()?.tasks["session-cleanup"]?.ok).toBe(true);
  });
});

describe("真实子进程路径", () => {
  test("bootstrap.ts __maintenance <payload> 跑完并落结果文件", async () => {
    const session = makeExpiredSession("20240101-000000-eeeeeeee");
    const bootstrap = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "cli",
      "src",
      "entrypoints",
      "bootstrap.ts",
    );
    const proc = Bun.spawn(["bun", bootstrap, "__maintenance", JSON.stringify(payload())], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SID_CONFIG_DIR: home },
    });
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(existsSync(session)).toBe(false);
    const r = readMaintenanceResult();
    expect(r?.pid).toBe(proc.pid);
    expect(r?.sessionCleanup?.deleted).toBe(1);
    // 单位是字节：一个 bun 进程的 RSS 不可能低于 10MB（防 KB/字节换算写错，第一版就错过）
    expect(r?.peakRssBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(existsSync(sidPaths.log("maintenance.log"))).toBe(true);
  }, 30_000);

  test("参数无效时安全退出，不做任何清理", async () => {
    const session = makeExpiredSession("20240101-000000-ffffffff");
    const bootstrap = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "cli",
      "src",
      "entrypoints",
      "bootstrap.ts",
    );
    const proc = Bun.spawn(["bun", bootstrap, "__maintenance", "{not json"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, SID_CONFIG_DIR: home },
    });
    expect(await proc.exited).toBe(0);
    expect(existsSync(session)).toBe(true);
  }, 30_000);
});
