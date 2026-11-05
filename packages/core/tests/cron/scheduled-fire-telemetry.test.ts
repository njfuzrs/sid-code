/**
 * 观测缺口 PR1 · T3：定时到点触发进轨迹（ScheduledFire）
 *
 * 这个事件要回答的是「到点了没有、晚了多久」——所以断言的核心是 `lag_ms`：
 * 会话忙时到期任务只会无限推迟（`warnOverdueWhileBusy` 一直在 logger 里喊），
 * 而那个推迟量此前没有任何取数源。
 *
 * 四个分支都要能分辨：fired / skipped_ungranted / claim_failed / fire_error。
 * 只记成功的话，`skipped_ungranted` 这类「任务建了但永远不跑」的形态仍然隐身。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSystemTime } from "bun:test";
import { Scheduler } from "@sid-code/core/cron/scheduler.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";
import {
  setScheduledTraceSink,
  SCHEDULED_FIRE_EVENT_NAME,
} from "@sid-code/core/cron/cron-telemetry.ts";

type Captured = { event: string; data: Record<string, unknown> };
let captured: Captured[] = [];
let dir: string;
const prevConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  captured = [];
  setScheduledTraceSink((event, data) => captured.push({ event, data }));
  dir = mkdtempSync(join(tmpdir(), "sid-cron-telemetry-"));
  process.env.SID_CONFIG_DIR = dir;
});

afterEach(() => {
  setScheduledTraceSink(null);
  setSystemTime(); // 恢复真实时间
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const fires = () => captured.filter((c) => c.event === SCHEDULED_FIRE_EVENT_NAME);

function makeScheduler(opts: { busy?: boolean; onFire?: (p: string, t?: CronTask) => void } = {}) {
  return new Scheduler({
    onFire: (p, t) => opts.onFire?.(p, t),
    isLoading: () => opts.busy === true,
    sessionId: "telemetry-test",
    workspaceDir: dir,
  });
}

function wakeupTask(over: Partial<CronTask> = {}): CronTask {
  return {
    id: "task-1",
    cron: "",
    prompt: "检查一下构建",
    createdAt: Date.now() - 1000,
    recurring: false,
    durable: false,
    fireAt: Date.now(),
    origin: "schedule_wakeup",
    ...over,
  };
}

describe("T3 ScheduledFire · 成功触发", () => {
  it("到点空闲：一条 fired，lag_ms 很小，字段齐全", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const now = Date.now();
    const s = makeScheduler();
    s.addSessionTask(wakeupTask({ fireAt: now }));
    (s as any).check();

    expect(fires()).toHaveLength(1);
    const d = fires()[0].data;
    expect(d.outcome).toBe("fired");
    expect(d.task_id).toBe("task-1");
    expect(d.origin).toBe("schedule_wakeup");
    expect(d.recurring).toBe(false);
    expect(d.durable).toBe(false);
    expect(d.dispatch).toBe("inject");
    expect(d.due_at).toBe(now);
    expect(d.fired_at).toBe(now);
    expect(d.lag_ms).toBe(0);
    expect(d.prompt_len).toBe("检查一下构建".length);
    expect(String(d.prompt_sha12)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("忙 10 分钟后空闲：lag_ms ≥ 600000（这是此前只有 logger 的那个数）", () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const opts = { busy: true };
    const s = makeScheduler(opts);
    s.addSessionTask(wakeupTask({ fireAt: t0 }));

    (s as any).check(); // 忙：不触发
    expect(fires()).toHaveLength(0);

    setSystemTime(new Date(t0 + 10 * 60 * 1000));
    opts.busy = false;
    (s as any).check();

    expect(fires()).toHaveLength(1);
    expect(fires()[0].data.outcome).toBe("fired");
    expect(Number(fires()[0].data.lag_ms)).toBeGreaterThanOrEqual(600_000);
  });

  it("onFire 收到 task（第二个参数），宿主据此发 ScheduledInject", () => {
    let gotTask: CronTask | undefined;
    const s = makeScheduler({ onFire: (_p, t) => (gotTask = t) });
    s.addSessionTask(wakeupTask());
    (s as any).check();
    expect(gotTask?.id).toBe("task-1");
    expect(gotTask?.origin).toBe("schedule_wakeup");
  });
});

describe("T3 ScheduledFire · 失败分支", () => {
  it("未授权 durable → skipped_ungranted", () => {
    const s = makeScheduler();
    const task = wakeupTask({ id: "durable-1", durable: true, origin: "cron_create" });
    // 直接驱动 fireOnce（而不是 check）：check 会先 refreshDurable() 把手工塞进缓存的
    // durable 任务重建掉。这里要测的就是「拿不到来源项目 = 未授权」这一条分支。
    (s as any).durableTasks.set(task.id, task);
    (s as any).fireOnce(task, Date.now(), false, "CRON");

    expect(fires()).toHaveLength(1);
    expect(fires()[0].data.outcome).toBe("skipped_ungranted");
    expect(fires()[0].data.durable).toBe(true);
  });

  it("onFire 抛错 → fire_error（不算 fired）", () => {
    const s = makeScheduler({
      onFire: () => {
        throw new Error("injector 挂了");
      },
    });
    s.addSessionTask(wakeupTask());
    (s as any).check();

    expect(fires()).toHaveLength(1);
    expect(fires()[0].data.outcome).toBe("fire_error");
  });

  it("缺 origin 的旧任务记 unknown，不回填", () => {
    const s = makeScheduler();
    const task = wakeupTask({ origin: undefined });
    s.addSessionTask(task);
    (s as any).check();
    expect(fires()[0].data.origin).toBe("unknown");
  });
});
