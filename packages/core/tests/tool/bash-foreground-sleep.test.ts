/**
 * N6 A 档：前台 `sleep N` 的引导回执（走真实工具入口 `BashTool.execute`）。
 *
 * 形态识别本身在 `tests/tool/bash/foreground-sleep.test.ts` 里测；这里钉的是
 * **追加条件与落点**：
 *   - 有声明的等待（wakeup / monitor / wait_until）→ 任何 ≥2s 的前台 sleep 都引导；
 *   - 没有声明的等待 → 只有 N ≥ 30 才引导（避免 `sleep 2 && curl …` 这类正常节奏被刷提示）；
 *   - 后台命令不引导（那正是引导要去的方向）；
 *   - 事件 `ForegroundSleepGuided` 只在**真的追加**时发一次，字段是闭集标签。
 *
 * 命令一律用 `timeout: 100`（被钳到 1000ms 下限）+ `sleep N` 的真实命令，
 * 既走了真实执行链（含超时分支），又不让单测等满 N 秒。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BashTool } from "../../src/tool/bash.ts";
import { clearAllTasks, registerTask } from "../../src/task/registry.ts";
import {
  __resetWaitRegistryForTest,
  hasDeclaredExternalWait,
  registerWait,
} from "../../src/task/wait-registry.ts";
import { __resetBackgroundAwaitForTest } from "../../src/task/background-await.ts";
import {
  FOREGROUND_SLEEP_GUIDED_EVENT_NAME,
  setGuidanceEventSink,
} from "../../src/query/guidance-events.ts";

let tool: BashTool;
let events: Array<{ event: string; data: Record<string, unknown> }> = [];

beforeEach(() => {
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  events = [];
  setGuidanceEventSink((event, data) => events.push({ event, data }));
  tool = new BashTool();
});

afterEach(() => {
  setGuidanceEventSink(null);
  clearAllTasks();
  __resetWaitRegistryForTest();
});

/** 造一个 running 的 shell 任务 + deadline 等待登记（等价于模型挂了 `wait_until_seconds`）。 */
function declareWaitUntil(id = "n6-wait-until"): void {
  registerTask({
    id,
    type: "local_shell",
    status: "running",
    description: "gh pr checks 701 --watch",
    startTime: Date.now(),
    outputFile: "/dev/null",
    outputOffset: 0,
    notified: false,
    command: "gh pr checks 701 --watch",
    interrupted: false,
    isBackgrounded: true,
  } as Parameters<typeof registerTask>[0]);
  const registered = registerWait({
    id,
    kind: "shell",
    promise: { kind: "deadline", deadlineAt: Date.now() + 1_800_000 },
    description: "gh pr checks 701 --watch",
    registeredAt: Date.now(),
  });
  expect(registered).toBe(true);
  expect(hasDeclaredExternalWait()).toBe(true);
}

describe("N6 A 档：有声明的等待 → 前台 sleep 引导", () => {
  test("挂了 wait_until 之后，sleep 3 也提示「只会阻塞本轮」并在末尾追加", async () => {
    declareWaitUntil();
    const result = await tool.execute({ command: "sleep 3", timeout: 100 });

    expect(result.output).toContain("[等待引导]");
    expect(result.output).toContain("你已经挂了等待源");
    expect(result.output).toContain("sleep 3");
    // 出口必须指向后台等待原语，而不是「再查一次」
    expect(result.output).toContain("wait_until_seconds");
    expect(result.output).toContain("monitor");
    expect(result.output).toContain("结束本轮");
    // 引导是追加，命令本身的超时说明仍在
    expect(result.output).toContain("命令执行超过 1 秒被终止（超时）");

    const emitted = events.filter((e) => e.event === FOREGROUND_SLEEP_GUIDED_EVENT_NAME);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.data).toMatchObject({
      seconds: 3,
      has_declared_wait: true,
      reason: "declared_wait",
    });
  });
});

describe("N6 A 档：没有声明的等待 → 只按 30s 阈值引导", () => {
  test("sleep 30（N ≥ 阈值）追加 long_sleep 引导", async () => {
    expect(hasDeclaredExternalWait()).toBe(false);
    const result = await tool.execute({
      command: "sleep 30 && gh pr checks 701",
      timeout: 100,
    });

    expect(result.output).toContain("[等待引导]");
    expect(result.output).toContain("阻塞了本轮");
    // 没有声明的等待时不能说「你已经挂了等待源」——模型没有挂，说了就是撒谎
    expect(result.output).not.toContain("你已经挂了等待源");

    const emitted = events.filter((e) => e.event === FOREGROUND_SLEEP_GUIDED_EVENT_NAME);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.data).toMatchObject({
      seconds: 30,
      has_declared_wait: false,
      reason: "long_sleep",
    });
  });

  test("sleep 5（低于阈值）不追加、不发事件——正常节奏不许被刷提示", async () => {
    const result = await tool.execute({ command: "sleep 5", timeout: 100 });

    expect(result.output).not.toContain("[等待引导]");
    expect(events.filter((e) => e.event === FOREGROUND_SLEEP_GUIDED_EVENT_NAME)).toHaveLength(0);
  });

  test("sleep 1 是正常节奏，连形态都不命中", async () => {
    const result = await tool.execute({ command: "sleep 1", timeout: 100 });
    expect(result.output).not.toContain("[等待引导]");
  });
});

describe("N6 A 档：不该引导的调用", () => {
  test("后台命令不引导（后台正是引导要去的方向）", async () => {
    const result = await tool.execute({
      command: "sleep 30",
      run_in_background: true,
      wait_until_seconds: 60,
    });
    // 后台回执是 JSON
    expect(result.output).toContain("task_id");
    expect(result.output).not.toContain("[等待引导]");
    expect(events.filter((e) => e.event === FOREGROUND_SLEEP_GUIDED_EVENT_NAME)).toHaveLength(0);
  });

  test("普通前台命令不引导", async () => {
    const result = await tool.execute({ command: "echo hi" });
    expect(result.output).not.toContain("[等待引导]");
    expect(events.filter((e) => e.event === FOREGROUND_SLEEP_GUIDED_EVENT_NAME)).toHaveLength(0);
  });

  test("管道里的 sleep 不引导", async () => {
    const result = await tool.execute({ command: "sleep 30 | cat", timeout: 100 });
    expect(result.output).not.toContain("[等待引导]");
  });
});
