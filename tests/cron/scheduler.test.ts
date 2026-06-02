/**
 * Spec 18 §5：Cron 调度系统单测
 * 覆盖解析器、确定性抖动、锁、调度器触发与过期。
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseCron,
  isValidCron,
  computeNextCronRun,
  jitteredNextFireMs,
} from "../../src/cron/parser.ts";
import {
  tryAcquireSchedulerLock,
  releaseSchedulerLock,
} from "../../src/cron/lock.ts";
import { Scheduler } from "../../src/cron/scheduler.ts";
import type { CronTask } from "../../src/cron/types.ts";

describe("cron parser", () => {
  it("解析 5 字段表达式", () => {
    const p = parseCron("*/5 9-17 * * 1-5");
    expect(p.minutes.has(0)).toBe(true);
    expect(p.minutes.has(5)).toBe(true);
    expect(p.minutes.has(3)).toBe(false);
    expect(p.hours.has(9)).toBe(true);
    expect(p.hours.has(17)).toBe(true);
    expect(p.hours.has(8)).toBe(false);
    expect(p.daysOfWeek.has(1)).toBe(true);
    expect(p.daysOfWeek.has(0)).toBe(false);
  });

  it("周字段 7 归一化为 0（周日）", () => {
    const p = parseCron("0 0 * * 7");
    expect(p.daysOfWeek.has(0)).toBe(true);
    expect(p.daysOfWeek.has(7)).toBe(false);
  });

  it("拒绝非 5 字段", () => {
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("* * * * * *")).toBe(false);
    expect(isValidCron("invalid")).toBe(false);
  });

  it("接受合法表达式", () => {
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("30 14 4 4 *")).toBe(true);
  });

  it("computeNextCronRun 计算每 5 分钟下一次", () => {
    // 2026-06-01 10:02:00 → 下一次每 5 分钟应是 10:05
    const from = new Date(2026, 5, 1, 10, 2, 0).getTime();
    const next = computeNextCronRun("*/5 * * * *", from);
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect(d.getMinutes()).toBe(5);
    expect(d.getHours()).toBe(10);
  });

  it("computeNextCronRun 计算工作日 9 点", () => {
    // 2026-06-06 是周六 → 下一个工作日 9 点应是周一 06-08
    const from = new Date(2026, 5, 6, 12, 0, 0).getTime();
    const next = computeNextCronRun("0 9 * * 1-5", from);
    const d = new Date(next!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect([1, 2, 3, 4, 5]).toContain(d.getDay());
  });

  it("一次性表达式：4月4日下午2:30", () => {
    const from = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const next = computeNextCronRun("30 14 4 4 *", from);
    const d = new Date(next!);
    expect(d.getMonth()).toBe(3); // 4月（0-indexed）
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("确定性抖动", () => {
  it("同 taskId 抖动稳定", () => {
    const from = new Date(2026, 5, 1, 10, 0, 0).getTime();
    const a = jitteredNextFireMs("0 * * * *", from, "task-abc");
    const b = jitteredNextFireMs("0 * * * *", from, "task-abc");
    expect(a).toBe(b);
  });

  it("不同 taskId 抖动通常不同", () => {
    const from = new Date(2026, 5, 1, 10, 0, 0).getTime();
    const a = jitteredNextFireMs("0 * * * *", from, "task-aaa");
    const b = jitteredNextFireMs("0 * * * *", from, "task-zzz");
    // 抖动因子不同，结果几乎必然不同
    expect(a).not.toBe(b);
  });

  it("抖动不超过周期 10%", () => {
    const from = new Date(2026, 5, 1, 10, 0, 0).getTime();
    const base = computeNextCronRun("0 * * * *", from)!; // 每小时
    const jittered = jitteredNextFireMs("0 * * * *", from, "x")!;
    const jitter = jittered - base;
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(60 * 60 * 1000 * 0.1 + 1);
  });
});

describe("调度器锁", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("首次获取成功，同会话幂等", () => {
    dir = mkdtempSync(join(tmpdir(), "sid-cron-"));
    writeFileSync(join(dir, ".gitkeep"), "");
    require("fs").mkdirSync(join(dir, ".sid-code"), { recursive: true });
    expect(tryAcquireSchedulerLock(dir, "sess-1")).toBe(true);
    expect(tryAcquireSchedulerLock(dir, "sess-1")).toBe(true); // 幂等
  });

  it("不同会话在持有者存活时抢锁失败", () => {
    dir = mkdtempSync(join(tmpdir(), "sid-cron-"));
    require("fs").mkdirSync(join(dir, ".sid-code"), { recursive: true });
    expect(tryAcquireSchedulerLock(dir, "sess-1")).toBe(true);
    // sess-2 抢锁：持有者 sess-1 的 pid 是当前进程，存活 → 失败
    expect(tryAcquireSchedulerLock(dir, "sess-2")).toBe(false);
  });

  it("释放后可重新获取", () => {
    dir = mkdtempSync(join(tmpdir(), "sid-cron-"));
    require("fs").mkdirSync(join(dir, ".sid-code"), { recursive: true });
    tryAcquireSchedulerLock(dir, "sess-1");
    releaseSchedulerLock(dir, "sess-1");
    expect(tryAcquireSchedulerLock(dir, "sess-2")).toBe(true);
  });
});

describe("调度器触发", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("到期任务触发 onFire", () => {
    dir = mkdtempSync(join(tmpdir(), "sid-cron-"));
    require("fs").mkdirSync(join(dir, ".sid-code"), { recursive: true });
    const fired: string[] = [];
    const scheduler = new Scheduler({
      onFire: (p) => fired.push(p),
      isLoading: () => false,
      sessionId: "s",
      workspaceDir: dir,
    });

    // 创建一个 createdAt 在过去的一次性任务，nextFire 应已过期
    const task: CronTask = {
      id: "t1",
      cron: "*/1 * * * *", // 每分钟
      prompt: "ping",
      createdAt: Date.now() - 5 * 60 * 1000, // 5 分钟前
      recurring: false,
      durable: false,
    };
    scheduler.addSessionTask(task);

    // 手动触发一次 check（用私有方法，通过 any 访问）
    (scheduler as any).check();
    expect(fired).toContain("ping");
    // 一次性任务触发后应被删除
    expect(scheduler.listTasks().find((t) => t.id === "t1")).toBeUndefined();
  });

  it("REPL 忙时不触发", () => {
    dir = mkdtempSync(join(tmpdir(), "sid-cron-"));
    require("fs").mkdirSync(join(dir, ".sid-code"), { recursive: true });
    const fired: string[] = [];
    const scheduler = new Scheduler({
      onFire: (p) => fired.push(p),
      isLoading: () => true, // 一直忙
      sessionId: "s",
      workspaceDir: dir,
    });
    scheduler.addSessionTask({
      id: "t2",
      cron: "*/1 * * * *",
      prompt: "x",
      createdAt: Date.now() - 5 * 60 * 1000,
      recurring: false,
      durable: false,
    });
    (scheduler as any).check();
    expect(fired.length).toBe(0);
  });

  it("removeTask 删除任务", () => {
    dir = mkdtempSync(join(tmpdir(), "sid-cron-"));
    require("fs").mkdirSync(join(dir, ".sid-code"), { recursive: true });
    const scheduler = new Scheduler({
      onFire: () => {},
      isLoading: () => false,
      sessionId: "s",
      workspaceDir: dir,
    });
    scheduler.addSessionTask({
      id: "t3", cron: "* * * * *", prompt: "y",
      createdAt: Date.now(), recurring: true, durable: false,
    });
    expect(scheduler.removeTask("t3")).toBe(true);
    expect(scheduler.removeTask("nope")).toBe(false);
    expect(scheduler.listTasks().length).toBe(0);
  });

  it("持久任务写盘并可重新加载", () => {
    dir = mkdtempSync(join(tmpdir(), "sid-cron-"));
    require("fs").mkdirSync(join(dir, ".sid-code"), { recursive: true });
    const s1 = new Scheduler({
      onFire: () => {}, isLoading: () => false, sessionId: "s1", workspaceDir: dir,
    });
    s1.start(); // 获取锁
    s1.addDurableTask({
      id: "d1", cron: "0 9 * * *", prompt: "daily",
      createdAt: Date.now(), recurring: true, durable: true,
    });
    expect(existsSync(join(dir, ".sid-code", "scheduled_tasks.json"))).toBe(true);
    s1.stop(); // 释放锁

    // 新调度器加载持久任务
    const s2 = new Scheduler({
      onFire: () => {}, isLoading: () => false, sessionId: "s2", workspaceDir: dir,
    });
    s2.start();
    expect(s2.listTasks().find((t) => t.id === "d1")).toBeDefined();
    s2.stop();
  });
});
