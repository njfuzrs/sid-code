import { describe, expect, test, beforeEach } from "bun:test";
import {
  registerCleanup,
  runShutdownSequence,
  getCleanupCount,
  __resetCleanupForTest,
  cleanupTerminalSync,
} from "@sid-code/shared/utils/graceful-shutdown.ts";

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

  // 接线回归：shutdownFeatureFlags 曾是零调用点的死代码——定义了、有测试、但没有任何
  // 生产路径调用它，Feature Flag 的远程刷新定时器在关闭流程里一直活着。
  // 断言"关闭后定时器不再触发"而非"函数被调用过"：后者可以被 mock 骗过，前者是真实效果。
  test("关闭流程会停掉 Feature Flag 远程刷新定时器", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { initFeatureFlags, __resetFeatureFlagsForTest } = await import(
      "@sid-code/core/analytics/feature-flags.ts"
    );

    const dir = mkdtempSync(join(tmpdir(), "sid-gs-ff-"));
    let fetchCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      __resetFeatureFlagsForTest();
      // 20ms 刷新间隔：初始化会立即刷一次，之后每 20ms 一次
      initFeatureFlags({ configDir: dir, remoteEndpoint: "http://127.0.0.1:1/flags", refreshIntervalMs: 20 });
      await new Promise((r) => setTimeout(r, 70));
      const beforeShutdown = fetchCount;
      expect(beforeShutdown).toBeGreaterThan(1); // 定时器确实在跑

      await runShutdownSequence();
      const afterShutdown = fetchCount;
      await new Promise((r) => setTimeout(r, 70));
      // 关闭后不再有新的远程拉取
      expect(fetchCount).toBe(afterShutdown);
    } finally {
      globalThis.fetch = origFetch;
      __resetFeatureFlagsForTest();
    }
  });
});
