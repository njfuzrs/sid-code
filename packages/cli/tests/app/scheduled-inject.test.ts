/**
 * 观测缺口 PR1 · T3：定时 prompt 注入进轨迹（ScheduledInject）
 *
 * 与 `ScheduledFire` 分开记的理由：一次「到点触发」在源码里是两个时刻。
 * 调度器侧只说明**决定触发**了；宿主侧这条才是「真的交给主循环」。
 * 中间那段等待（会话忙时排队）此前完全不可见——`queue_wait_ms` 就是它。
 *
 * 两条硬约束：
 *   1. 入队时不发事件（否则排队时间为 0，事件失去意义）；
 *   2. 注入器抛错重入队时，同一次 flush 内不重复发（一条 prompt 一轮只对应一次尝试）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSystemTime } from "bun:test";
import { App } from "@sid-code/cli/app.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import {
  setScheduledTraceSink,
  SCHEDULED_INJECT_EVENT_NAME,
} from "@sid-code/core/cron/cron-telemetry.ts";

type Captured = { event: string; data: Record<string, unknown> };
let captured: Captured[] = [];
let dir: string;
const prevConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  captured = [];
  setScheduledTraceSink((event, data) => captured.push({ event, data }));
  dir = mkdtempSync(join(tmpdir(), "sid-scheduled-inject-"));
  process.env.SID_CONFIG_DIR = dir;
});

afterEach(() => {
  setScheduledTraceSink(null);
  setSystemTime();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(): App {
  const config = {
    ...defaultConfig(),
    model: "mock-model",
    provider: "mock",
    availableModels: [],
  } as unknown as Config;
  return new App({
    unifiedRegistry: new UnifiedCommandRegistry(),
    config,
    provider: {} as never,
    mcpManager: {} as never,
  });
}

const injects = () => captured.filter((c) => c.event === SCHEDULED_INJECT_EVENT_NAME);

describe("T3 ScheduledInject", () => {
  it("空闲直接注入：queued=false，queue_wait_ms≈0", async () => {
    // 冻结时钟：`firedAt` 在 enqueue 时取、注入前再取一次 `Date.now()`（app.ts 的
    // injectScheduledPrompt），真实时钟下两次取值跨过 1ms 边界就得 1，`toBe(0)` 随机红
    // （2026-11-05 CI 上 ubuntu 3 次 / macOS 2 次）。空闲直接注入时 0 或 1ms 都正确，
    // 修的是测试的时序依赖，生产代码不动；afterEach 已复位系统时钟。
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const app = makeApp();
    const injected: string[] = [];
    (app as any).busy = false;
    (app as any).promptInjector = async (t: string) => {
      injected.push(t);
    };

    await app.enqueueScheduledPrompt("hello", { id: "task-1" });

    expect(injected).toEqual(["hello"]);
    expect(injects()).toHaveLength(1);
    expect(injects()[0].data.task_id).toBe("task-1");
    expect(injects()[0].data.queued).toBe(false);
    expect(injects()[0].data.queue_wait_ms).toBe(0);
  });

  it("忙时入队：入队不发事件，空闲 flush 时 queued=true 且 queue_wait_ms 等于时间差", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));

    const app = makeApp();
    const injected: string[] = [];
    (app as any).busy = true;
    (app as any).promptInjector = async (t: string) => {
      injected.push(t);
    };

    await app.enqueueScheduledPrompt("queued-prompt", { id: "task-2" });
    expect(injects()).toHaveLength(0); // 入队不记
    expect(injected).toHaveLength(0);

    setSystemTime(new Date(t0 + 5 * 60 * 1000));
    (app as any).busy = false;
    await (app as any).flushScheduledPrompts();

    expect(injected).toEqual(["queued-prompt"]);
    expect(injects()).toHaveLength(1);
    expect(injects()[0].data.task_id).toBe("task-2");
    expect(injects()[0].data.queued).toBe(true);
    expect(injects()[0].data.queue_wait_ms).toBe(5 * 60 * 1000);
  });

  it("注入器抛错重入队：本轮只发一条；下次 flush 恢复后正常注入", async () => {
    const app = makeApp();
    let shouldThrow = true;
    const injected: string[] = [];
    (app as any).busy = false;
    (app as any).promptInjector = async (t: string) => {
      if (shouldThrow) throw new Error("injector 挂了");
      injected.push(t);
    };

    // 走 flush 路径：入队 → flush 抛错 → 重入队
    (app as any).busy = true;
    await app.enqueueScheduledPrompt("retry-me", { id: "task-3" });
    (app as any).busy = false;
    await (app as any).flushScheduledPrompts();

    expect(injects()).toHaveLength(1); // 同一次 flush 内不重复发
    expect(injects()[0].data.task_id).toBe("task-3");
    expect(injected).toHaveLength(0);

    // 重入队后下一轮 flush 成功
    shouldThrow = false;
    await (app as any).flushScheduledPrompts();
    expect(injected).toEqual(["retry-me"]);
    expect(injects()).toHaveLength(2); // 第二次尝试是新的注入事件
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F2：注入前判过期 / F3：注入来源标记（2026-11-07 缺陷修复）
//
// F1 能消除「新建时」的积压，但覆盖不到这个窗口：旧唤醒已经 fire、进了宿主的
// scheduledPromptQueue，之后才被新唤醒替换——这时它已不在 SessionTasks 里，F1 删不到。
// F2 在注入前问调度器一句「这个 id 还被算数吗」，靠的是调度器的事实，不是宿主
// 自己推断「排在后面的更新」（两条唤醒可能因 lag 不同而乱序进队）。
// ───────────────────────────────────────────────────────────────────────────
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";

/** 造一个会话级任务（origin 决定是否参与 F2 的过期判定） */
function sessionTask(
  id: string,
  origin: CronTask["origin"],
  extra: Partial<CronTask> = {},
): CronTask {
  return {
    id,
    cron: "",
    prompt: `p-${id}`,
    createdAt: Date.now(),
    recurring: false,
    durable: false,
    fireAt: Date.now() + 60_000,
    origin,
    ...extra,
  };
}

describe("F2 注入前判过期", () => {
  beforeEach(() => {
    resetScheduler();
  });
  afterEach(() => {
    resetScheduler();
  });

  it("T-F2-1 已被替换的唤醒不注入，发 outcome=dropped_superseded", async () => {
    // 冻结时钟：queue_wait_ms 断言用
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const app = makeApp();
    const injected: string[] = [];
    (app as any).busy = true;
    (app as any).promptInjector = async (t: string) => {
      injected.push(t);
    };

    // 忙时入队（模拟：A 已经 fire 进队列）
    await app.enqueueScheduledPrompt("stale-A", { id: "A", origin: "schedule_wakeup" });
    expect(injects()).toHaveLength(0); // 入队不发事件

    // 之后 A 被更新的唤醒替换（此时 A 已不在 sessionTasks 里，F1 删不到它）
    const sched = getScheduler();
    sched.addSessionTask(sessionTask("A", "schedule_wakeup"));
    sched.replaceSessionTasksByOrigin(sessionTask("B", "schedule_wakeup"));
    expect(sched.isSuperseded("A")).toBe(true);

    (app as any).busy = false;
    await (app as any).flushScheduledPrompts();

    expect(injected).toHaveLength(0);
    expect(injects()).toHaveLength(1);
    expect(injects()[0].data.task_id).toBe("A");
    expect(injects()[0].data.outcome).toBe("dropped_superseded");
  });

  it("T-F2-2 没被替换的唤醒正常注入，outcome=injected", async () => {
    const app = makeApp();
    const injected: string[] = [];
    (app as any).busy = true;
    (app as any).promptInjector = async (t: string) => {
      injected.push(t);
    };

    await app.enqueueScheduledPrompt("fresh", { id: "A2", origin: "schedule_wakeup" });
    (app as any).busy = false;
    await (app as any).flushScheduledPrompts();

    expect(injected).toEqual(["fresh"]);
    expect(injects()).toHaveLength(1);
    expect(injects()[0].data.outcome).toBe("injected");
  });

  it("T-F2-3 origin=loop 的任务即使在 superseded 集合里也照常注入", async () => {
    const app = makeApp();
    const injected: string[] = [];
    (app as any).busy = true;
    (app as any).promptInjector = async (t: string) => {
      injected.push(t);
    };

    // 构造：/loop 的一次性任务被同 origin 的更新任务替换过（F2 只作用于 schedule_wakeup）
    const sched = getScheduler();
    sched.addSessionTask(sessionTask("L1", "loop"));
    sched.replaceSessionTasksByOrigin(sessionTask("L2", "loop"));
    expect(sched.isSuperseded("L1")).toBe(true);

    await app.enqueueScheduledPrompt("loop-prompt", { id: "L1", origin: "loop" });
    (app as any).busy = false;
    await (app as any).flushScheduledPrompts();

    expect(injected).toEqual(["loop-prompt"]);
    expect(injects()[0].data.outcome).toBe("injected");
  });
});

describe("F3 注入来源标记", () => {
  it("T-F3-1 注入器收到的第二个参数是 { taskId, origin }", async () => {
    const app = makeApp();
    const sources: unknown[] = [];
    (app as any).busy = false;
    (app as any).promptInjector = async (_t: string, source?: unknown) => {
      sources.push(source);
    };

    await app.enqueueScheduledPrompt("hello", { id: "task-9", origin: "schedule_wakeup" });
    expect(sources).toEqual([{ taskId: "task-9", origin: "schedule_wakeup" }]);
  });

  it("T-F3-1b 没有来源信息时第二个参数是 undefined（普通路径不受影响）", async () => {
    const app = makeApp();
    const sources: unknown[] = [];
    (app as any).busy = false;
    (app as any).promptInjector = async (_t: string, source?: unknown) => {
      sources.push(source);
    };

    await app.enqueueScheduledPrompt("no-source");
    expect(sources).toEqual([undefined]);
  });
});
