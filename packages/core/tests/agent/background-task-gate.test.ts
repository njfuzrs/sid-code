/**
 * end_turn 后台任务单飞闸门 —— 方案 §6 判据 4
 *
 * 判据原文：**`end_turn` 后无新 `fetch_sent`（并发）**。
 * 闸门层面等价的可测形态是：两个不同的后台任务不可能同时在跑。
 *
 * 为什么这条测试有价值（而不是在测一个显然的布尔量）：
 * 各任务**自己**的重入锁是已经存在的（`session-memory.ts` / `extractor.ts` 各有 pending），
 * 而它恰恰是失效的那一层 —— 两把独立的锁在语义上表达不出"后台任务全局最多跑一个"。
 * 所以这里测的是**跨任务**的互斥，那才是本次事故没有的东西。
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  runBackgroundTask,
  drainBackgroundTasks,
  getBackgroundGateStats,
  resetBackgroundTaskGate,
} from "../../src/agent/background-task-gate.ts";

describe("background-task-gate", () => {
  beforeEach(() => resetBackgroundTaskGate());

  test("判据 4：两个**不同**任务不能并发（这是各自 pending 锁防不住的那一层）", async () => {
    let aRunning = false;
    let sawConcurrent = false;
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));

    const admittedA = runBackgroundTask("session-memory-update", async () => {
      aRunning = true;
      await blocker;
      aRunning = false;
    });
    // B 在 A 还在跑时来 —— 这正是实测里两个 fork 交替发请求的形态
    const admittedB = runBackgroundTask("memory-extract", async () => {
      if (aRunning) sawConcurrent = true;
    });

    expect(admittedA).toBe(true);
    expect(admittedB).toBe(false); // 没有当场启动（记为待补）
    expect(getBackgroundGateStats().pendingLabels).toEqual(["memory-extract"]);
    expect(sawConcurrent).toBe(false);

    release();
    await new Promise((r) => setTimeout(r, 5));
    await drainBackgroundTasks();
    expect(sawConcurrent).toBe(false); // B 在 A 结束之后才跑
    expect(getBackgroundGateStats().deferred).toBe(1);
    expect(getBackgroundGateStats().admitted).toBe(2);
  });

  test("F3：同一次 end_turn 紧挨着提交的两个不同任务，两个都会跑（串行）", async () => {
    // 复现 query/loop.ts 唯一调用点的真实形态：两条同步语句紧挨着提交。
    // 旧语义下第二条恒被丢弃，记忆提取触发率恒为 0。
    const order: string[] = [];
    runBackgroundTask("session-memory-update", async () => {
      order.push("sm:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("sm:end");
    });
    runBackgroundTask("memory-extract", async () => {
      order.push("extract");
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual(["sm:start", "sm:end", "extract"]);
  });

  test("F3：待补按 label 封顶为 1，不堆积", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    let bRan = 0;
    runBackgroundTask("a", () => blocker);
    for (let i = 0; i < 5; i++) {
      runBackgroundTask("b", async () => {
        bRan++;
      });
    }
    expect(getBackgroundGateStats().pendingLabels).toEqual(["b"]);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(bRan).toBe(1);
  });

  test("与在跑任务同 label 的直接丢弃（它自己已经在跑）", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    runBackgroundTask("a", () => blocker);
    expect(runBackgroundTask("a", async () => {})).toBe(false);
    expect(getBackgroundGateStats().rejected).toBe(1);
    expect(getBackgroundGateStats().pendingLabels).toEqual([]);
    release();
    await drainBackgroundTasks();
  });

  test("退出时 drain 丢弃待补任务，不在退出时新起一个 fork", async () => {
    // 刚发出的十万 token 级 fork 会被进程退出掐断，只白烧钱。
    let bRan = 0;
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    runBackgroundTask("a", () => blocker);
    runBackgroundTask("b", async () => {
      bRan++;
    });
    release();
    await drainBackgroundTasks();
    await new Promise((r) => setTimeout(r, 5));
    expect(bRan).toBe(0);
  });

  test("闸门在任务跑完后释放，下一个 end_turn 能正常放行", async () => {
    runBackgroundTask("a", async () => {});
    await drainBackgroundTasks();
    expect(getBackgroundGateStats().busy).toBe(false);
    expect(runBackgroundTask("b", async () => {})).toBe(true);
    await drainBackgroundTasks();
  });

  test("任务抛异常也要释放闸门（否则从防并发变成永久堵死）", async () => {
    runBackgroundTask("boom", async () => {
      throw new Error("x");
    });
    await drainBackgroundTasks();
    expect(getBackgroundGateStats().busy).toBe(false);
    expect(runBackgroundTask("next", async () => {})).toBe(true);
    await drainBackgroundTasks();
  });

  test("**同步**抛出同样要释放闸门（这条最容易漏：同步抛会绕过 .catch）", async () => {
    runBackgroundTask("sync-boom", () => {
      throw new Error("sync");
    });
    await drainBackgroundTasks();
    expect(getBackgroundGateStats().busy).toBe(false);
    expect(runBackgroundTask("next", async () => {})).toBe(true);
    await drainBackgroundTasks();
  });

  test("不阻塞调用方：runBackgroundTask 同步返回，不等任务完成", async () => {
    // 这条钉住 B3 的否决（await 会把收尾延迟拉长到实测 44s）。
    let done = false;
    runBackgroundTask("slow", async () => {
      await new Promise((r) => setTimeout(r, 50));
      done = true;
    });
    expect(done).toBe(false); // 已经返回了，任务还没跑完
    await drainBackgroundTasks();
    expect(done).toBe(true);
  });

  test("drain 超时不抛错（后台任务不值得阻塞退出）", async () => {
    runBackgroundTask("never", () => new Promise<void>(() => {}));
    const t0 = Date.now();
    await drainBackgroundTasks(30);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("background-task-gate 退出收尾（F3）", () => {
  test("首次放行即注册 pre-flush 关闭钩子，runShutdownSequence 会等在跑的任务", async () => {
    const gs = await import("@sid-code/shared/utils/graceful-shutdown.ts");
    gs.__resetCleanupForTest();
    resetBackgroundTaskGate();
    let done = false;
    runBackgroundTask("session-memory-update", async () => {
      await new Promise((r) => setTimeout(r, 30));
      done = true;
    });
    expect(gs.getShutdownHookNames()).toContain("background-task-gate");
    await gs.runShutdownSequence();
    expect(done).toBe(true);
    gs.__resetCleanupForTest();
  });
});
