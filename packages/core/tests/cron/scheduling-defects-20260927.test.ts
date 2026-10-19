/**
 * 调度侧缺陷回归（docs-research 20260927「编排与调度」第二部分 + P1-9 / P3-2）。
 *
 * 每条都对应一个修复前为真的失败形态，注释里写修复前的实测值。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseCron,
  isValidCron,
  computeNextCronRun,
  computeLatestMissedRun,
} from "@sid-code/core/cron/parser.ts";
import { parseIntervalToSeconds, intervalToCron } from "@sid-code/core/cron/interval.ts";
import { fireAtToHuman, describeTaskSchedule } from "@sid-code/core/cron/describe.ts";
import { Scheduler, getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";
import { CronCreateTool } from "@sid-code/core/tool/cron-create.ts";
import { CronListTool } from "@sid-code/core/tool/cron-list.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";

describe("P2-1 a/n 步长按标准 cron 展开为 a-max/n", () => {
  it("5/10 在分字段 = 5,15,…,55（修复前只有 [5]）", () => {
    expect([...parseCron("5/10 * * * *").minutes].sort((a, b) => a - b)).toEqual([
      5, 15, 25, 35, 45, 55,
    ]);
  });

  it("小时字段 2/6 = 2,8,14,20；*/15 与 a-b/n 不回归", () => {
    expect([...parseCron("0 2/6 * * *").hours].sort((a, b) => a - b)).toEqual([2, 8, 14, 20]);
    expect([...parseCron("*/15 * * * *").minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCron("10-30/10 * * * *").minutes].sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });
});

describe("P2-2 范围端点越界报错，不再静默截断", () => {
  it("周字段 1-99 被拒（修复前被接受成「每天」）", () => {
    expect(isValidCron("0 0 * * 1-99")).toBe(false);
    expect(() => parseCron("0 0 * * 1-99")).toThrow(/无效范围/);
  });

  it("其他字段的范围上界越界同样被拒", () => {
    expect(isValidCron("0-60 * * * *")).toBe(false);
    expect(isValidCron("0 0 1-32 * *")).toBe(false);
    expect(isValidCron("0 0 * 0-12 *")).toBe(false);
  });

  it("合法边界与 7=周日 不受影响", () => {
    expect(isValidCron("0-59 0-23 1-31 1-12 0-7")).toBe(true);
    expect([...parseCron("0 0 * * 5-7").daysOfWeek].sort()).toEqual([0, 5, 6]);
  });
});

describe("P1-5 永不匹配的 cron：求值不再扫 210 万次，cron_create 拒绝创建", () => {
  it("2 月 30 日 / 4 月 31 日 返回 null 且远快于修复前的 ~70ms", () => {
    for (const expr of ["0 0 30 2 *", "0 0 31 2 *", "0 0 31 4 *"]) {
      const t0 = performance.now();
      expect(computeNextCronRun(expr, Date.now())).toBeNull();
      expect(performance.now() - t0).toBeLessThan(10);
    }
  });

  it("闰日 2/29 仍能找到（跳月优化不能把它跳丢）", () => {
    const from = new Date(2026, 2, 1).getTime();
    const next = computeNextCronRun("0 0 29 2 *", from);
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2028, 2, 29]);
  });

  it("cron_create 对永不触发的表达式报错（修复前回「已创建」）", async () => {
    const res = await new CronCreateTool().execute({ cron: "0 0 30 2 *", prompt: "x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("永远不会触发");
  });
});

describe("P1-4 computeLatestMissedRun 不受 maxRuns 前向截断影响", () => {
  it("每分钟任务停机 26 天，返回的是真正最后一次（修复前是 20 天前的第 10000 次）", () => {
    const from = new Date(2026, 8, 1, 0, 0, 0).getTime();
    const until = new Date(2026, 8, 27, 0, 0, 0).getTime();
    expect(computeLatestMissedRun("* * * * *", from, until)).toBe(until);
  });

  it("区间开端不算：(from, until] 左开", () => {
    const from = new Date(2026, 5, 1, 9, 0, 0).getTime();
    const until = new Date(2026, 5, 1, 9, 0, 30).getTime();
    expect(computeLatestMissedRun("0 9 * * *", from, until)).toBeNull();
  });

  it("跨月、跨年的稀疏任务回扫到正确时刻", () => {
    const from = new Date(2025, 0, 1).getTime();
    const until = new Date(2026, 8, 27).getTime();
    const latest = computeLatestMissedRun("30 4 1 3 *", from, until);
    const d = new Date(latest!);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 3, 1, 4, 30,
    ]);
  });
});

describe("P3-2 /loop 间隔：重复/乱序单位被拒，实际周期单独返回", () => {
  it("5m5m / 1h1h / 3m2h 被拒（修复前分别累加成 600s / 7200s / 7380s）", () => {
    expect(parseIntervalToSeconds("5m5m")).toBeNull();
    expect(parseIntervalToSeconds("1h1h")).toBeNull();
    expect(parseIntervalToSeconds("3m2h")).toBeNull();
  });

  it("合法组合不回归", () => {
    expect(parseIntervalToSeconds("1h30m")).toBe(5400);
    expect(parseIntervalToSeconds("1H 30M")).toBe(5400);
    expect(parseIntervalToSeconds("2h30m15s")).toBe(9015);
  });

  it("亚分钟间隔：effectiveSeconds=60，totalSeconds 保留原值", () => {
    const r = intervalToCron("10s")!;
    expect(r.cron).toBe("*/1 * * * *");
    expect(r.totalSeconds).toBe(10);
    expect(r.effectiveSeconds).toBe(60);
    expect(intervalToCron("2h")!.effectiveSeconds).toBe(7200);
  });
});

describe("P2-5 fireAt 唤醒在列表里显示触发时刻", () => {
  it("fireAtToHuman 给出绝对时刻 + 相对时长", () => {
    const now = new Date(2026, 9, 20, 10, 0, 0).getTime();
    expect(fireAtToHuman(now + 120_000, now)).toBe("10-20 10:02:00 唤醒（2 分钟后）");
    expect(fireAtToHuman(now - 1, now)).toContain("已到期");
  });

  it('describeTaskSchedule：fireAt 任务不再走 cronToHuman("") 渲染成空白', () => {
    const s = describeTaskSchedule({ cron: "", fireAt: Date.now() + 90_000 });
    expect(s).toContain("唤醒");
    expect(describeTaskSchedule({ cron: "*/5 * * * *" })).toBe("每 5 分钟（*/5 * * * *）");
  });
});

describe("调度器实例", () => {
  let home: string;
  let project: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sid-sched-home-"));
    project = mkdtempSync(join(tmpdir(), "sid-sched-proj-"));
    prevHome = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = home;
    prevCwd = process.cwd();
    resetScheduler();
  });

  afterEach(() => {
    resetScheduler();
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const sessionTask = (id: string, over: Partial<CronTask> = {}): CronTask => ({
    id,
    cron: "* * * * *",
    prompt: `p-${id}`,
    createdAt: Date.now() - 120_000,
    recurring: true,
    durable: false,
    ...over,
  });

  it("P2-3 兜底实例被带 opts 的调用替换，兜底期间建的任务迁过去并真的触发", () => {
    // 修复前：early === real，fired 恒为空
    const early = getScheduler();
    expect(early.addSessionTask(sessionTask("t1"))).toBe(true);
    const fired: string[] = [];
    const real = getScheduler({
      onFire: (p) => fired.push(p),
      isLoading: () => false,
      sessionId: "real",
      workspaceDir: project,
      isDaemonRunning: () => false,
    });
    expect(real).not.toBe(early);
    expect(getScheduler()).toBe(real);
    expect(real.listTasks().map((t) => t.id)).toEqual(["t1"]);
    (real as any).check();
    expect(fired).toEqual(["p-t1"]);
  });

  it("P2-3 正式实例不会被后续带 opts 的调用替换", () => {
    const opts = {
      onFire: () => {},
      isLoading: () => false,
      sessionId: "a",
      workspaceDir: project,
    };
    const a = getScheduler(opts);
    expect(getScheduler({ ...opts, sessionId: "b" })).toBe(a);
  });

  it("P1-6 会话先起、daemon 后起：下一轮检查会话让出 durable 驱动", () => {
    let daemon = false;
    const s = new Scheduler({
      onFire: () => {},
      isLoading: () => false,
      sessionId: "sess",
      workspaceDir: project,
      isDaemonRunning: () => daemon,
    });
    s.start();
    s.addDurableTask(sessionTask("d1", { durable: true, workspaceDir: project }));
    (s as any).check();
    expect(s.isDrivingDurable()).toBe(true);
    daemon = true;
    (s as any).check();
    expect(s.isDrivingDurable()).toBe(false);
    s.stop();
  });

  it("P2-4 任务文件损坏时 cron_list 明说读取失败，而不是「没有任务」", async () => {
    mkdirSync(join(project, ".sid-code"), { recursive: true });
    writeFileSync(join(project, ".sid-code", "scheduled_tasks.json"), "[{ broken");
    process.chdir(project);
    getScheduler({
      onFire: () => {},
      isLoading: () => false,
      sessionId: "x",
      workspaceDir: project,
      isDaemonRunning: () => false,
    });
    const res = await new CronListTool().execute();
    expect(res.isError).toBe(true);
    expect(res.output).toContain("持久任务文件读取失败");
    expect(res.output).toContain("scheduled_tasks.json");
  });

  it("P2-5 会话一直忙时，超期的唤醒任务会告警（修复前完全静默）", () => {
    const { getLogger } = require("@sid-code/core/debug/logger.ts");
    const logger = getLogger();
    const warns: string[] = [];
    const orig = logger.warn;
    logger.warn = (_tag: string, msg: string) => warns.push(msg);
    try {
      const s = new Scheduler({
        onFire: () => {},
        isLoading: () => true,
        sessionId: "busy",
        workspaceDir: project,
        isDaemonRunning: () => false,
      });
      s.addSessionTask(
        sessionTask("w1", { cron: "", recurring: false, fireAt: Date.now() - 10 * 60_000 }),
      );
      (s as any).check();
      (s as any).check();
      const hits = warns.filter((w) => w.includes("w1") && w.includes("会话一直忙"));
      expect(hits).toHaveLength(1);
    } finally {
      logger.warn = orig;
    }
  });
});
