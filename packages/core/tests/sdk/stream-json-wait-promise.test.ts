/**
 * D11 真实入口：stream-json 无头等待用「带承诺的等待源」判据，不再提前退出。
 *
 * ## 验的是什么
 *
 * 事故形态（#674）：`echo '{…}' | sid-code --input-format stream-json` 里模型起了
 * `wait_until` 后台 shell 等 CI，命令静默 60s+（等 CI 时是常态）。stdin 关闭后
 * `runHeadlessStreaming` 用 `hasAwaitedBackgroundTasks()` 判「有没有值得等的后台任务」，
 * 该判据对 shell 要求 `shellSilentForMs < SHELL_QUIESCENT_MS`，于是判「没有」→ 直接收尾退出，
 * 后台 shell 随进程被带走。`schedule_wakeup` 同病（它不在 task registry 里，旧判据完全看不到）。
 *
 * 修法（`cli/src/app.ts` 的 SDK driver）：注入点换成 `hasPromisedWait()` —— 旧判据的超集。
 * 本文件从 `runHeadlessStreaming` 真实入口验两件事：
 * 1. `wait_until` 静默 61s+ 时，stdin 关闭后循环**不退出**；shell 进终态才退；
 * 2. 已排唤醒时同样不退出；到点注入后才退。
 *
 * 两条都先断言「旧判据 false / 新判据 true」，把 D11 的差异本身也锁住：
 * 用旧判据的实现跑这两条必然提前退出（变异自证见 Agent Note）。
 *
 * ## engine 是鸭子类型的
 *
 * `backgroundOf(engine)` 用 `?.call(engine)` 逐个取可选能力，缺省 = 没有后台任务，
 * 行为与改动前一致。所以这里不需要真实 `SDKQueryEngine`，只用最小假 engine。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHeadless } from "@sid-code/core/sdk/headless-runner.ts";
import { StructuredIO } from "@sid-code/core/sdk/structured-io.ts";
import { CommandQueue } from "@sid-code/core/sdk/command-queue.ts";
import type { SDKQueryEngine } from "@sid-code/core/sdk/query-engine.ts";
import {
  hasPendingNotifications,
  subscribeBackgroundActivity,
} from "@sid-code/core/task/background-wake.ts";
import {
  __resetBackgroundAwaitForTest,
  hasAwaitedBackgroundTasks,
  SHELL_QUIESCENT_MS,
  trackShellActivity,
} from "@sid-code/core/task/background-await.ts";
import {
  __resetWaitRegistryForTest,
  hasPromisedWait,
  registerWait,
  releaseWait,
  setWakeupRegistrationEnabled,
} from "@sid-code/core/task/wait-registry.ts";
import { clearAllTasks, registerTask, updateTask } from "@sid-code/core/task/registry.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

/** 最小假 engine：只有 submitMessage 产出一轮 result，其余走真实实现 */
function waitAwareEngine(): SDKQueryEngine {
  return {
    async *submitMessage(input: string) {
      yield { type: "result", subtype: "success", result: `收到: ${input}` };
    },
    // D11 的关键接线：与修复后的 app.ts 同一条判据
    hasRunningBackgroundTasks: () => hasPromisedWait(),
    hasPendingNotifications: () => hasPendingNotifications(),
    subscribeBackgroundActivity: (listener: () => void) => subscribeBackgroundActivity(listener),
  } as unknown as SDKQueryEngine;
}

function runningShell(id: string, description: string): LocalShellTaskState {
  const task: LocalShellTaskState = {
    id,
    type: "local_shell",
    status: "running",
    description,
    startTime: Date.now(),
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: "wait_until 600s gh pr checks 662 --watch",
    interrupted: false,
    isBackgrounded: true,
  };
  registerTask(task);
  return task;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 断言一个 promise 在 ms 内没有结算；返回结算状态（false = 仍在挂着） */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(ms);
  return settled;
}

async function mustFinish(p: Promise<unknown>, ms: number, why: string): Promise<void> {
  const timer = sleep(ms).then(() => {
    throw new Error(`${why}（${ms}ms 内没有结束）`);
  });
  await Promise.race([p, timer]);
}

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-d11-stream-json-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  resetScheduler();
});

afterEach(() => {
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("D11：stream-json 无头等待判据", () => {
  test("wait_until shell 静默 61s+：stdin 关闭后循环不退出，shell 终态才退", async () => {
    runningShell("w-until", "等 PR #662 CI");
    // 静默超过阈值：派生口径判「不值得等」，只有显式 deadline 登记能救它
    trackShellActivity("w-until", 0, Date.now() - SHELL_QUIESCENT_MS - 1_000);
    registerWait({
      id: "w-until",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 600_000 },
      description: "等 PR #662 CI",
      registeredAt: Date.now(),
    });

    // D11 的差异本身：旧判据 false / 新判据 true
    expect(hasAwaitedBackgroundTasks()).toBe(false);
    expect(hasPromisedWait()).toBe(true);

    const input = new PassThrough();
    const output = new PassThrough();
    const run = runHeadless(waitAwareEngine(), {
      outputFormat: "stream-json",
      structuredIO: new StructuredIO(input, output),
      commandQueue: new CommandQueue(),
      output,
      initialPrompt: "等 CI 绿了再合并",
    });

    // 第一轮跑完后关 stdin：旧判据会在这里直接收尾退出
    await sleep(120);
    input.end();

    expect(await settledWithin(run, 150)).toBe(false);

    // shell 终态 → releaseTerminalWaits 释放登记 + 补通知 → 循环重判后退出
    updateTask<LocalShellTaskState>("w-until", (t) => ({ ...t, status: "completed" }));
    await mustFinish(run, 2_000, "shell 终态后循环没有退出");
  }, 15_000);

  test("已排唤醒：stdin 关闭后循环不退出，到点注入后才退", async () => {
    setWakeupRegistrationEnabled(true);
    const fired: string[] = [];
    let inject: ((text: string) => void) | null = null;

    const fireAt = Date.now() - 1; // 已到期，手动 check() 触发真实 fireOnce 路径
    getScheduler({
      onFire: (prompt, task) => {
        fired.push(prompt);
        // 扮演 App.injectScheduledPrompt 的两个动作：释放登记 + 注入主循环
        if (task?.id) releaseWait(task.id, "terminal");
        inject?.(prompt);
      },
      isLoading: () => false,
      sessionId: "d11",
      workspaceDir: tmpHome,
    });
    const wakeup: CronTask = {
      id: "wk-d11",
      cron: "",
      prompt: "定时唤醒：检查 CI 结果",
      createdAt: Date.now(),
      recurring: false,
      durable: false,
      fireAt,
      origin: "schedule_wakeup",
    };
    getScheduler().addSessionTask(wakeup);
    registerWait({
      id: "wk-d11",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: fireAt },
      description: "检查 CI 结果",
      registeredAt: Date.now(),
    });

    expect(hasAwaitedBackgroundTasks()).toBe(false); // 唤醒不在 task registry 里
    expect(hasPromisedWait()).toBe(true);

    const input = new PassThrough();
    const output = new PassThrough();
    const run = runHeadless(waitAwareEngine(), {
      outputFormat: "stream-json",
      structuredIO: new StructuredIO(input, output),
      commandQueue: new CommandQueue(),
      output,
      initialPrompt: "排个唤醒等 CI",
      onInjectorReady: (fn) => {
        inject = fn;
      },
    });

    for (let i = 0; i < 500 && !inject; i++) await sleep(2);
    expect(inject).not.toBeNull();

    await sleep(120);
    input.end();
    expect(await settledWithin(run, 150)).toBe(false);

    // 到点：真实 check() → fireOnce → fireTask → onFire（释放 + 注入）
    (getScheduler() as any).check();
    expect(fired).toHaveLength(1);
    await mustFinish(run, 2_000, "唤醒注入后循环没有退出");
  }, 15_000);
});
