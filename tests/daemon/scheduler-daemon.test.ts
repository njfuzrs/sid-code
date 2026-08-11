/**
 * 缺口 C1 守护进程层单测
 * 覆盖：单例锁互斥/stale 回收、durable-projects 注册表自愈、
 *       HeadlessExecutor 输出抽取、Scheduler daemon 模式 catch-up「只补最近一次」。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  tryAcquireDaemonLock,
  releaseDaemonLock,
  isDaemonRunning,
  readDaemonLock,
} from "@sid-code/core/daemon/lock.ts";
import {
  registerDurableProject,
  listDurableProjects,
  unregisterDurableProject,
} from "@sid-code/core/daemon/durable-projects.ts";
import { extractFinalResponse } from "@sid-code/core/daemon/headless-executor.ts";
import { Scheduler } from "@sid-code/core/cron/scheduler.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-daemon-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  try { releaseDaemonLock(); } catch { /* 忽略 */ }
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe("守护进程单例锁", () => {
  it("首次获取成功，写入锁文件", () => {
    expect(tryAcquireDaemonLock()).toBe(true);
    const lock = readDaemonLock();
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
  });

  it("已持有时再抢失败（同进程模拟第二个守护进程）", () => {
    expect(tryAcquireDaemonLock()).toBe(true);
    // 锁文件 pid=当前进程，存活 → 第二次抢锁失败
    expect(tryAcquireDaemonLock()).toBe(false);
  });

  it("isDaemonRunning 反映存活状态", () => {
    expect(isDaemonRunning()).toBe(false);
    tryAcquireDaemonLock();
    expect(isDaemonRunning()).toBe(true);
    releaseDaemonLock();
    expect(isDaemonRunning()).toBe(false);
  });

  it("stale 锁（已死 pid）被回收", () => {
    // 手动写一个不存在 pid 的锁
    const { sidPaths } = require("@sid-code/core/config/paths.ts");
    mkdirSync(sidPaths.state(), { recursive: true });
    writeFileSync(
      sidPaths.stateFile("daemon.lock"),
      JSON.stringify({ pid: 999999999, startedAt: Date.now(), version: "x" }),
    );
    // 死 pid → isDaemonRunning 回收并返回 false
    expect(isDaemonRunning()).toBe(false);
    // 回收后可重新获取
    expect(tryAcquireDaemonLock()).toBe(true);
  });

  it("release 仅当自己持有时删除", () => {
    tryAcquireDaemonLock();
    expect(readDaemonLock()).not.toBeNull();
    releaseDaemonLock();
    expect(readDaemonLock()).toBeNull();
  });
});

describe("durable-projects 注册表", () => {
  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "sid-proj-"));
    mkdirSync(join(dir, ".sid-code"), { recursive: true });
    writeFileSync(
      join(dir, ".sid-code", "scheduled_tasks.json"),
      JSON.stringify([{ id: "a", cron: "0 9 * * *", prompt: "x", createdAt: 1, recurring: true, durable: true }]),
    );
    return dir;
  }

  it("登记后可列出", () => {
    const p = makeProject();
    try {
      registerDurableProject(p);
      expect(listDurableProjects()).toContain(p);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it("幂等：重复登记不产生重复项", () => {
    const p = makeProject();
    try {
      registerDurableProject(p);
      registerDurableProject(p);
      expect(listDurableProjects().filter((x) => x === p).length).toBe(1);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it("自愈：项目目录被删后从清单剔除", () => {
    const p = makeProject();
    registerDurableProject(p);
    expect(listDurableProjects()).toContain(p);
    // 删掉项目
    rmSync(p, { recursive: true, force: true });
    // listDurableProjects 自愈剔除
    expect(listDurableProjects()).not.toContain(p);
  });

  it("自愈：scheduled_tasks.json 不存在则剔除", () => {
    const p = makeProject();
    try {
      registerDurableProject(p);
      rmSync(join(p, ".sid-code", "scheduled_tasks.json"));
      expect(listDurableProjects()).not.toContain(p);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it("unregister 显式移除", () => {
    const p = makeProject();
    try {
      registerDurableProject(p);
      unregisterDurableProject(p);
      expect(listDurableProjects()).not.toContain(p);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });
});

describe("HeadlessExecutor.extractFinalResponse", () => {
  it("解析 app.ts runHeadless json content[] 结构", () => {
    const json = JSON.stringify({
      session_id: "s1",
      role: "assistant",
      content: [
        { type: "text", text: "第一段" },
        { type: "tool_use", name: "bash" },
        { type: "text", text: "第二段" },
      ],
    });
    expect(extractFinalResponse(json)).toBe("第一段\n第二段");
  });

  it("兼容 final_response 字段", () => {
    expect(extractFinalResponse(JSON.stringify({ final_response: "ok" }))).toBe("ok");
  });

  it("非 JSON 原样返回", () => {
    expect(extractFinalResponse("plain text")).toBe("plain text");
  });

  it("空输入返回空串", () => {
    expect(extractFinalResponse("   ")).toBe("");
  });
});

describe("Scheduler daemon 模式 catch-up", () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  function setupProjectWithTask(task: CronTask): string {
    const dir = mkdtempSync(join(tmpdir(), "sid-proj-"));
    mkdirSync(join(dir, ".sid-code"), { recursive: true });
    writeFileSync(
      join(dir, ".sid-code", "scheduled_tasks.json"),
      JSON.stringify([task]),
    );
    registerDurableProject(dir);
    return dir;
  }

  it("启动时对错过的循环任务只补一次（onFireTask 收到完整 task）", () => {
    // 日任务 09:00，lastFired 在 6 天前 → 应 catch-up 补 1 次
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    projectDir = setupProjectWithTask({
      id: "daily1",
      cron: "0 9 * * *",
      prompt: "daily-report",
      createdAt: sixDaysAgo,
      recurring: true,
      durable: true,
      lastFiredAt: sixDaysAgo,
    });

    const fired: CronTask[] = [];
    const scheduler = new Scheduler({
      daemonMode: true,
      onFire: () => {},
      onFireTask: (t) => fired.push(t),
      isLoading: () => false,
      sessionId: "daemon-test",
      workspaceDir: projectDir,
    });
    scheduler.start();

    // 只补一次（不是 6 次）
    expect(fired.length).toBe(1);
    expect(fired[0].prompt).toBe("daily-report");
    // workspaceDir 缺省回退到项目根
    expect(fired[0].workspaceDir).toBe(projectDir);
    scheduler.stop();
  });

  it("daemon 模式跨项目加载 durable 任务", () => {
    projectDir = setupProjectWithTask({
      id: "load1",
      cron: "0 9 * * *",
      prompt: "p",
      createdAt: Date.now(),
      recurring: true,
      durable: true,
      lastFiredAt: Date.now(), // 刚跑过，不触发 catch-up
    });

    const scheduler = new Scheduler({
      daemonMode: true,
      onFire: () => {},
      onFireTask: () => {},
      isLoading: () => false,
      sessionId: "daemon-test",
      workspaceDir: projectDir,
    });
    scheduler.start();
    expect(scheduler.listTasks().find((t) => t.id === "load1")).toBeDefined();
    scheduler.stop();
  });

  it("daemon 模式下 durable 循环任务不因 7 天上限过期", () => {
    // createdAt 在 10 天前（超过 maxAgeDays=7），交互式会过期，daemon 模式不过期
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    projectDir = setupProjectWithTask({
      id: "longrun",
      cron: "0 9 * * *",
      prompt: "p",
      createdAt: tenDaysAgo,
      recurring: true,
      durable: true,
      lastFiredAt: Date.now(), // 刚跑过，避免 catch-up 干扰
    });

    const scheduler = new Scheduler({
      daemonMode: true,
      onFire: () => {},
      onFireTask: () => {},
      isLoading: () => false,
      sessionId: "daemon-test",
      workspaceDir: projectDir,
    });
    scheduler.start();
    // 手动触发 check：daemon durable 任务不应被过期删除
    (scheduler as any).check();
    expect(scheduler.listTasks().find((t) => t.id === "longrun")).toBeDefined();
    scheduler.stop();
  });
});
