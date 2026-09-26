/**
 * P0-1 / P0-2：cron 任务上限守卫 + 整体禁用开关。
 *
 * 守卫下沉在 Scheduler.addSessionTask / addDurableTask，所以三个创建入口
 * （cron_create / schedule_wakeup / /loop）共用同一套断言。
 * 禁用开关测两层：工具层拒绝创建、调度器 start() 不启动轮询。
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Scheduler, resetScheduler, getScheduler } from "@sid-code/core/cron/scheduler.ts";
import {
  MAX_SESSION_CRON_JOBS,
  MAX_DAEMON_CRON_JOBS,
  DISABLE_CRON_ENV,
  isCronDisabled,
  type CronTask,
} from "@sid-code/core/cron/types.ts";
import { CronCreateTool } from "@sid-code/core/tool/cron-create.ts";
import { ScheduleWakeupTool } from "@sid-code/core/tool/schedule-wakeup.ts";

let prevDisable: string | undefined;

afterEach(() => {
  resetScheduler();
  if (prevDisable === undefined) delete process.env[DISABLE_CRON_ENV];
  else process.env[DISABLE_CRON_ENV] = prevDisable;
});

function saveDisableEnv(): void {
  prevDisable = process.env[DISABLE_CRON_ENV];
}

/** 造一个最小会话级任务。 */
function sessionTask(id: string): CronTask {
  return {
    id,
    cron: "*/5 * * * *",
    prompt: "x",
    createdAt: Date.now(),
    recurring: true,
    durable: false,
  };
}

describe("P0-1 任务上限", () => {
  it("会话级任务达到 50 后 addSessionTask 拒绝且不入队", () => {
    const scheduler = new Scheduler({
      onFire: () => {},
      isLoading: () => false,
      sessionId: "s",
      workspaceDir: mkdtempSync(join(tmpdir(), "sid-cron-cap-")),
    });
    for (let i = 0; i < MAX_SESSION_CRON_JOBS; i++) {
      expect(scheduler.addSessionTask(sessionTask(`t${i}`))).toBe(true);
    }
    expect(scheduler.listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS);
    // 第 51 个被拒，清单不变
    expect(scheduler.addSessionTask(sessionTask("overflow"))).toBe(false);
    expect(scheduler.listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS);
    expect(scheduler.listTasks().some((t) => t.id === "overflow")).toBe(false);
    scheduler.stop();
  });

  it("删除一个后可以再建", () => {
    const scheduler = new Scheduler({
      onFire: () => {},
      isLoading: () => false,
      sessionId: "s",
      workspaceDir: mkdtempSync(join(tmpdir(), "sid-cron-cap-")),
    });
    for (let i = 0; i < MAX_SESSION_CRON_JOBS; i++) scheduler.addSessionTask(sessionTask(`t${i}`));
    expect(scheduler.addSessionTask(sessionTask("overflow"))).toBe(false);
    expect(scheduler.removeTask("t0")).toBe(true);
    expect(scheduler.addSessionTask(sessionTask("again"))).toBe(true);
    expect(scheduler.listTasks().some((t) => t.id === "again")).toBe(true);
    scheduler.stop();
  });

  it("daemon 模式的持久任务上限是 500，不受会话级 50 约束", () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-cron-daemon-"));
    const scheduler = new Scheduler({
      daemonMode: true,
      onFire: () => {},
      isLoading: () => false,
      sessionId: "daemon",
      workspaceDir: dir,
    });
    expect(scheduler.durableCap()).toBe(MAX_DAEMON_CRON_JOBS);
    expect(scheduler.sessionCap()).toBe(MAX_SESSION_CRON_JOBS);
    // 超过会话级上限仍可添加（daemon 档独立）
    for (let i = 0; i < MAX_SESSION_CRON_JOBS + 1; i++) {
      expect(
        scheduler.addDurableTask({ ...sessionTask(`d${i}`), durable: true, workspaceDir: dir }),
      ).toBe(true);
    }
    expect(scheduler.listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS + 1);
    scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("cron_create 达上限时返回上限错误且不创建", async () => {
    const tool = new CronCreateTool();
    for (let i = 0; i < MAX_SESSION_CRON_JOBS; i++) {
      const res = await tool.execute({ cron: "*/5 * * * *", prompt: `p${i}` });
      expect(res.isError).toBeFalsy();
    }
    const overflow = await tool.execute({ cron: "*/5 * * * *", prompt: "太多了" });
    expect(overflow.isError).toBe(true);
    expect(overflow.output).toContain(`已达定时任务上限 (${MAX_SESSION_CRON_JOBS})`);
    expect(getScheduler().listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS);
  });

  it("schedule_wakeup 与 cron_create 共享同一个上限", async () => {
    const cron = new CronCreateTool();
    for (let i = 0; i < MAX_SESSION_CRON_JOBS; i++) {
      await cron.execute({ cron: "*/5 * * * *", prompt: `p${i}` });
    }
    const wakeup = new ScheduleWakeupTool();
    const res = await wakeup.execute({ delay_seconds: 120, prompt: "检查" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("已达定时任务上限");
    expect(getScheduler().listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS);
  });
});

describe("P0-2 整体禁用开关", () => {
  it("未设置时不禁用", () => {
    saveDisableEnv();
    delete process.env[DISABLE_CRON_ENV];
    expect(isCronDisabled()).toBe(false);
  });

  it("=1 与 =true 都视为禁用，其他值不算", () => {
    saveDisableEnv();
    process.env[DISABLE_CRON_ENV] = "1";
    expect(isCronDisabled()).toBe(true);
    process.env[DISABLE_CRON_ENV] = "true";
    expect(isCronDisabled()).toBe(true);
    process.env[DISABLE_CRON_ENV] = "0";
    expect(isCronDisabled()).toBe(false);
    process.env[DISABLE_CRON_ENV] = "yes";
    expect(isCronDisabled()).toBe(false);
  });

  it("禁用时 cron_create 与 schedule_wakeup 都拒绝", async () => {
    saveDisableEnv();
    process.env[DISABLE_CRON_ENV] = "1";
    const created = await new CronCreateTool().execute({ cron: "*/5 * * * *", prompt: "x" });
    expect(created.isError).toBe(true);
    expect(created.output).toContain("SID_CODE_DISABLE_CRON");
    const wakeup = await new ScheduleWakeupTool().execute({ delay_seconds: 120, prompt: "x" });
    expect(wakeup.isError).toBe(true);
    expect(getScheduler().listTasks()).toHaveLength(0);
  });

  it("禁用时 start() 不启动轮询，已有任务不会被触发", async () => {
    saveDisableEnv();
    const dir = mkdtempSync(join(tmpdir(), "sid-cron-off-"));
    let fired = 0;
    const scheduler = new Scheduler({
      onFire: () => {
        fired++;
      },
      isLoading: () => false,
      sessionId: "s",
      workspaceDir: dir,
      checkIntervalMs: 20,
    });
    // 一个早已到期的一次性任务：不禁用时下一轮检查必触发
    scheduler.addSessionTask({
      id: "due",
      cron: "",
      prompt: "该触发了",
      createdAt: Date.now() - 10_000,
      recurring: false,
      durable: false,
      fireAt: Date.now() - 1000,
    });
    process.env[DISABLE_CRON_ENV] = "1";
    scheduler.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(0);
    scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
