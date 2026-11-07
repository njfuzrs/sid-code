/**
 * F1：`schedule_wakeup` 单链语义（2026-11-07 缺陷修复）
 *
 * 缺陷形态（会话 `20261107-095213-ff96d1f2`）：模型在一轮内调了 5 次 `schedule_wakeup`，
 * 产生 5 个并存的一次性任务，目标达成后仍多跑了 4 轮完整主循环。根因是整条链上
 * **没有一处**会查看或撤销本会话已有的同 origin 任务，上限 50 等于允许积压 50 个。
 *
 * 修法：`Scheduler.replaceSessionTasksByOrigin` —— 同 origin 的会话级一次性任务
 * 新增即替换（单链），被替换的 id 记进 `supersededIds` 供宿主注入前判过期（F2）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSystemTime } from "bun:test";
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";
import { ScheduleWakeupTool } from "@sid-code/core/tool/schedule-wakeup.ts";
import { MAX_SESSION_CRON_JOBS, type CronTask } from "@sid-code/core/cron/types.ts";
import {
  SCHEDULED_REPLACE_EVENT_NAME,
  setScheduledTraceSink,
} from "@sid-code/core/cron/cron-telemetry.ts";

type Captured = { event: string; data: Record<string, unknown> };

let dir: string;
let fired: string[];
const prevConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  // T-F1-8：调度器会碰 durable 路径（workspaceDir / 日志），隔离到 tmpdir。
  // 存/恢复原值而不 delete——同批多文件跑在同一进程里，delete 会把 preload 的兜底一起抹掉。
  dir = mkdtempSync(join(tmpdir(), "sid-wakeup-single-chain-"));
  process.env.SID_CONFIG_DIR = dir;
  resetScheduler();
  fired = [];
  getScheduler({
    onFire: (prompt) => fired.push(prompt),
    isLoading: () => false,
    sessionId: "test-session",
    workspaceDir: dir,
  });
});

afterEach(() => {
  resetScheduler();
  setSystemTime();
  setScheduledTraceSink(null);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个指定 origin 的会话级任务（不经过工具，用于构造「已有别的任务」场景） */
function sessionTask(
  id: string,
  origin: CronTask["origin"],
  extra: Partial<CronTask> = {},
): CronTask {
  return {
    id,
    cron: "",
    prompt: `prompt-${id}`,
    createdAt: Date.now(),
    recurring: false,
    durable: false,
    fireAt: Date.now() + 60_000,
    origin,
    ...extra,
  };
}

const wakeups = () =>
  getScheduler()
    .listTasks()
    .filter((t) => t.origin === "schedule_wakeup");

describe("F1 schedule_wakeup 单链", () => {
  it("T-F1-1 连续调 3 次只保留最后一个", async () => {
    const tool = new ScheduleWakeupTool();
    const r1 = await tool.execute({ delay_seconds: 60, prompt: "A" });
    const r2 = await tool.execute({ delay_seconds: 70, prompt: "B" });
    const r3 = await tool.execute({ delay_seconds: 80, prompt: "C" });
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r3.isError).toBeFalsy();

    const remaining = wakeups();
    expect(remaining).toHaveLength(1);
    const lastId = /ID: ([0-9a-f]+)/.exec(r3.output!)?.[1];
    expect(remaining[0].id).toBe(lastId!);
    expect(remaining[0].prompt).toBe("C");
  });

  it("T-F1-2 第二次起返回文案说明替换，第一次不含", async () => {
    const tool = new ScheduleWakeupTool();
    const r1 = await tool.execute({ delay_seconds: 60, prompt: "A" });
    const id1 = /ID: ([0-9a-f]+)/.exec(r1.output!)![1];
    expect(r1.output).not.toContain("已替换");

    const r2 = await tool.execute({ delay_seconds: 70, prompt: "B" });
    expect(r2.output).toContain("已替换");
    // 告诉模型旧 id 已经没了，免得它去 cron_delete 一个不存在的 id
    expect(r2.output).toContain(id1);
    // 也告诉它怎么撤掉最后这一个（§6.3 的缓解）
    const id2 = /ID: ([0-9a-f]+)/.exec(r2.output!)![1];
    expect(r2.output).toContain(`cron_delete ${id2}`);
  });

  it("T-F1-3 被替换的唤醒不会再 fire，onFire 只收到最新 prompt", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const tool = new ScheduleWakeupTool();
    await tool.execute({ delay_seconds: 60, prompt: "A" });
    await tool.execute({ delay_seconds: 70, prompt: "B" });
    await tool.execute({ delay_seconds: 80, prompt: "C" });

    // 越过三条 fireAt（最晚 80s）再驱动一轮 check
    setSystemTime(new Date("2026-01-01T00:02:00Z"));
    (getScheduler() as any).check();

    expect(fired).toEqual(["C"]);
  });

  it("T-F1-4 不误伤 /loop 固定间隔与 cron_create 任务", async () => {
    const sched = getScheduler();
    sched.addSessionTask(sessionTask("loop-1", "loop", { cron: "*/1 * * * *", recurring: true }));
    sched.addSessionTask(sessionTask("cron-1", "cron_create"));

    await new ScheduleWakeupTool().execute({ delay_seconds: 60, prompt: "A" });
    await new ScheduleWakeupTool().execute({ delay_seconds: 60, prompt: "B" });

    const ids = sched.listTasks().map((t) => t.id);
    expect(ids).toContain("loop-1");
    expect(ids).toContain("cron-1");
    expect(wakeups()).toHaveLength(1);
  });

  it("T-F1-5 达上限时替换仍然可行；没有可替换的任务时才报错", async () => {
    const sched = getScheduler();
    // 49 个 cron_create 一次性任务 + 1 个 schedule_wakeup = 满 50
    for (let i = 0; i < MAX_SESSION_CRON_JOBS - 1; i++) {
      sched.addSessionTask(sessionTask(`c-${i}`, "cron_create"));
    }
    const first = await new ScheduleWakeupTool().execute({ delay_seconds: 60, prompt: "A" });
    expect(first.isError).toBeFalsy();
    expect(sched.listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS);

    // 第 50 个是 schedule_wakeup，再来一个应当替换而不是报满
    const second = await new ScheduleWakeupTool().execute({ delay_seconds: 60, prompt: "B" });
    expect(second.isError).toBeFalsy();
    expect(second.output).toContain("已替换");
    expect(sched.listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS);

    // 换一个全新调度器：满 50 且一个 schedule_wakeup 都没有 → 仍按原文案报错
    resetScheduler();
    const fresh = getScheduler({
      onFire: () => {},
      isLoading: () => false,
      sessionId: "test-session",
      workspaceDir: dir,
    });
    for (let i = 0; i < MAX_SESSION_CRON_JOBS; i++) {
      fresh.addSessionTask(sessionTask(`x-${i}`, "cron_create"));
    }
    const third = await new ScheduleWakeupTool().execute({ delay_seconds: 60, prompt: "C" });
    expect(third.isError).toBe(true);
    expect(third.output).toContain(`上限 (${MAX_SESSION_CRON_JOBS})`);
  });

  it("T-F1-6 替换发一条 ScheduledReplace，首次创建不发", async () => {
    const captured: Captured[] = [];
    setScheduledTraceSink((event, data) => captured.push({ event, data }));
    const replaces = () => captured.filter((c) => c.event === SCHEDULED_REPLACE_EVENT_NAME);

    const tool = new ScheduleWakeupTool();
    const r1 = await tool.execute({ delay_seconds: 60, prompt: "A" });
    expect(replaces()).toHaveLength(0);

    const r2 = await tool.execute({ delay_seconds: 60, prompt: "B" });
    const id1 = /ID: ([0-9a-f]+)/.exec(r1.output!)![1];
    const id2 = /ID: ([0-9a-f]+)/.exec(r2.output!)![1];
    expect(replaces()).toHaveLength(1);
    expect(replaces()[0].data.task_id).toBe(id2);
    expect(replaces()[0].data.origin).toBe("schedule_wakeup");
    expect(replaces()[0].data.replaced).toEqual([id1]);
    expect(replaces()[0].data.replaced_count).toBe(1);
    // 不记 prompt 原文（与 G3 隐私约定一致）
    expect(JSON.stringify(replaces()[0].data)).not.toContain("A");
  });

  it("T-F1-7 被替换的 id 标记为 superseded，新 id 不是", async () => {
    const tool = new ScheduleWakeupTool();
    const r1 = await tool.execute({ delay_seconds: 60, prompt: "A" });
    const r2 = await tool.execute({ delay_seconds: 60, prompt: "B" });
    const id1 = /ID: ([0-9a-f]+)/.exec(r1.output!)![1];
    const id2 = /ID: ([0-9a-f]+)/.exec(r2.output!)![1];

    expect(getScheduler().isSuperseded(id1)).toBe(true);
    expect(getScheduler().isSuperseded(id2)).toBe(false);
  });

  it("T-F1-8 origin 缺省的任务不被误删", () => {
    // 老任务 / 从盘上读出来的 durable 任务没有 origin。判据不能写成 `t.origin === origin`，
    // 那会把所有同样缺 origin 的任务当成同 origin，一次替换清掉别人建的任务。
    const sched = getScheduler();
    sched.addSessionTask({
      id: "no-origin",
      cron: "",
      prompt: "old",
      createdAt: Date.now(),
      recurring: false,
      durable: false,
      fireAt: Date.now() + 60_000,
    });
    const r = sched.replaceSessionTasksByOrigin(sessionTask("new", undefined));
    expect(r.ok).toBe(true);
    expect(r.replaced).toEqual([]);
    expect(sched.listTasks().map((t) => t.id)).toContain("no-origin");
  });
});
