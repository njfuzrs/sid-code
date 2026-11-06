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
