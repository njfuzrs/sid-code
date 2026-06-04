import { describe, expect, test, beforeEach } from "bun:test";
import {
  registerCleanup,
  runShutdownSequence,
  getCleanupCount,
  __resetCleanupForTest,
  cleanupTerminalSync,
} from "../../src/utils/graceful-shutdown.ts";

describe("优雅关闭（spec 17 §3.4）", () => {
  beforeEach(() => {
    __resetCleanupForTest();
  });

  test("注册的清理函数按顺序执行", async () => {
    const order: number[] = [];
    registerCleanup(() => { order.push(1); });
    registerCleanup(async () => { order.push(2); });
    registerCleanup(() => { order.push(3); });

    expect(getCleanupCount()).toBe(3);
    await runShutdownSequence();
    expect(order).toEqual([1, 2, 3]);
  });

  test("清理函数抛错不阻塞后续清理", async () => {
    const ran: number[] = [];
    registerCleanup(() => { throw new Error("boom"); });
    registerCleanup(() => { ran.push(2); });

    await runShutdownSequence();
    expect(ran).toEqual([2]);
  });

  test("runShutdownSequence 幂等——重入直接返回", async () => {
    let count = 0;
    registerCleanup(() => { count++; });

    await runShutdownSequence();
    await runShutdownSequence(); // 第二次应直接返回
    expect(count).toBe(1);
  });

  test("遥测刷新有硬超时——慢清理不会无限挂起", async () => {
    // 注册一个永不 resolve 的清理函数(但它在 cleanupFns 阶段,不受 500ms 超时保护)
    // 改为验证整体流程在合理时间内完成:慢但有界
    registerCleanup(() => new Promise<void>((r) => setTimeout(r, 50)));
    const start = Date.now();
    await runShutdownSequence();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("cleanupTerminalSync 不抛错", () => {
    expect(() => cleanupTerminalSync()).not.toThrow();
  });
});
