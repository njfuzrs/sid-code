/**
 * Phase 1 基础设施工具单测
 * 覆盖：errors-util / cleanup-registry / sequential / generators / memoize-ttl / memoize-lru
 */

import { describe, test, expect } from "bun:test";
import { toError, errorMessage, shortErrorStack } from "@sid-code/shared/utils/errors-util.ts";
import {
  registerCleanup,
  runCleanupFunctions,
  cleanupCount,
  clearCleanupRegistry,
} from "@sid-code/shared/utils/cleanup-registry.ts";
import { sequential } from "@sid-code/shared/utils/sequential.ts";
import { all, toArray } from "@sid-code/shared/utils/generators.ts";
import { memoizeWithTTL, memoizeWithTTLAsync } from "@sid-code/shared/utils/memoize-ttl.ts";
import { memoizeWithLRU } from "@sid-code/shared/utils/memoize-lru.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── errors-util ─────────────────────────────

describe("errors-util", () => {
  test("toError 把非 Error 包装为 Error", () => {
    expect(toError("boom")).toBeInstanceOf(Error);
    expect(toError("boom").message).toBe("boom");
    const e = new Error("x");
    expect(toError(e)).toBe(e); // 原样返回
  });

  test("errorMessage 提取消息", () => {
    expect(errorMessage(new Error("hi"))).toBe("hi");
    expect(errorMessage(42)).toBe("42");
  });

  test("shortErrorStack 截断到 maxFrames 帧", () => {
    const e = new Error("deep");
    // 构造一个多帧 stack
    e.stack = [
      "Error: deep",
      "    at a (f.ts:1:1)",
      "    at b (f.ts:2:1)",
      "    at c (f.ts:3:1)",
      "    at d (f.ts:4:1)",
      "    at e (f.ts:5:1)",
      "    at f (f.ts:6:1)",
      "    at g (f.ts:7:1)",
    ].join("\n");
    const out = shortErrorStack(e, 3);
    expect(out).toContain("Error: deep");
    expect(out).toContain("at a");
    expect(out).toContain("at c");
    expect(out).not.toContain("at g");
    expect(out).toContain("truncated");
  });

  test("shortErrorStack 帧数不足时原样返回", () => {
    const e = new Error("shallow");
    e.stack = "Error: shallow\n    at a (f.ts:1:1)";
    expect(shortErrorStack(e, 5)).toBe(e.stack);
  });
});

// ──────────────────────────── cleanup-registry ────────────────────────────

describe("cleanup-registry", () => {
  test("注册 / 注销 / 并行执行", async () => {
    clearCleanupRegistry();
    const order: string[] = [];
    const un1 = registerCleanup(async () => {
      order.push("a");
    });
    registerCleanup(async () => {
      order.push("b");
    });
    expect(cleanupCount()).toBe(2);

    un1(); // 注销 a
    expect(cleanupCount()).toBe(1);

    const errs = await runCleanupFunctions();
    expect(errs).toEqual([]);
    expect(order).toEqual(["b"]);
  });

  test("单个清理失败不影响其他，错误被收集", async () => {
    clearCleanupRegistry();
    let ran = false;
    registerCleanup(async () => {
      throw new Error("fail-1");
    });
    registerCleanup(async () => {
      ran = true;
    });
    const errs = await runCleanupFunctions();
    expect(ran).toBe(true);
    expect(errs.length).toBe(1);
    expect((errs[0] as Error).message).toBe("fail-1");
    clearCleanupRegistry();
  });
});

// ─────────────────────────────── sequential ───────────────────────────────

describe("sequential", () => {
  test("并发调用被串行化，保序执行", async () => {
    const events: string[] = [];
    const wrapped = sequential(async (id: number, delay: number) => {
      events.push(`start-${id}`);
      await tick(delay);
      events.push(`end-${id}`);
      return id;
    });

    // 先发的 delay 更长，若并行则 end-2 会先于 end-1
    const results = await Promise.all([wrapped(1, 30), wrapped(2, 1), wrapped(3, 1)]);

    expect(results).toEqual([1, 2, 3]);
    // 严格串行：每个 start 后紧跟自己的 end
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  test("错误隔离：一个 reject 不阻断后续", async () => {
    const wrapped = sequential(async (x: number) => {
      if (x === 2) throw new Error("boom");
      return x * 10;
    });
    const p1 = wrapped(1);
    const p2 = wrapped(2);
    const p3 = wrapped(3);

    expect(await p1).toBe(10);
    let caught: unknown;
    try {
      await p2;
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("boom");
    expect(await p3).toBe(30);
  });

  test("保留 this 上下文", async () => {
    const obj = {
      base: 100,
      add: sequential(async function (this: { base: number }, n: number) {
        return this.base + n;
      }),
    };
    expect(await obj.add(5)).toBe(105);
  });
});

// ─────────────────────────────── generators ───────────────────────────────

async function* genOf<T>(items: T[], delayMs = 0): AsyncGenerator<T, void> {
  for (const it of items) {
    if (delayMs) await tick(delayMs);
    yield it;
  }
}

describe("generators.all", () => {
  test("并发消费多个 generator，全部值都被 yield", async () => {
    const out = await toArray(all([genOf([1, 2]), genOf([3, 4]), genOf([5])]));
    expect(out.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("边完成边 yield：快的先出", async () => {
    const out = await toArray(all([genOf(["slow"], 30), genOf(["fast"], 1)]));
    expect(out[0]).toBe("fast");
    expect(out).toContain("slow");
  });

  test("并发上限被遵守", async () => {
    let active = 0;
    let maxActive = 0;
    const makeGen = (): AsyncGenerator<number, void> =>
      (async function* () {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick(5);
        yield 1;
        active--;
      })();

    await toArray(all([makeGen(), makeGen(), makeGen(), makeGen()], 2));
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("空输入返回空", async () => {
    expect(await toArray(all([]))).toEqual([]);
  });
});

// ────────────────────────────── memoize-ttl ──────────────────────────────

describe("memoizeWithTTL", () => {
  test("冷启动计算，未过期复用", () => {
    let calls = 0;
    const fn = memoizeWithTTL((x: number) => {
      calls++;
      return x * 2;
    }, 10_000);

    expect(fn(5)).toBe(10);
    expect(fn(5)).toBe(10);
    expect(calls).toBe(1);
  });

  test("过期返回旧值并后台刷新", async () => {
    let value = 1;
    const fn = memoizeWithTTL(() => value, 1); // 1ms TTL

    expect(fn()).toBe(1); // 冷启动
    value = 2;
    await tick(5); // 让其过期

    // 过期：立即返回旧值（1），触发后台刷新
    expect(fn()).toBe(1);
    await tick(5); // 等后台 microtask 完成
    expect(fn()).toBe(2); // 刷新后拿到新值
  });

  test("clear 清空缓存", () => {
    let calls = 0;
    const fn = memoizeWithTTL(() => ++calls, 10_000);
    fn();
    fn.cache.clear();
    fn();
    expect(calls).toBe(2);
  });
});

describe("memoizeWithTTLAsync", () => {
  test("并发冷启动只执行一次（去重）", async () => {
    let calls = 0;
    const fn = memoizeWithTTLAsync(async () => {
      calls++;
      await tick(10);
      return "v";
    }, 10_000);

    const [a, b, c] = await Promise.all([fn(), fn(), fn()]);
    expect([a, b, c]).toEqual(["v", "v", "v"]);
    expect(calls).toBe(1);
  });

  test("失败时自纠正，下次重试", async () => {
    let attempt = 0;
    const fn = memoizeWithTTLAsync(async () => {
      attempt++;
      if (attempt === 1) throw new Error("first-fail");
      return "ok";
    }, 10_000);

    let caught: unknown;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("first-fail");
    expect(await fn()).toBe("ok"); // 重试成功
  });
});

// ────────────────────────────── memoize-lru ──────────────────────────────

describe("memoizeWithLRU", () => {
  test("缓存命中不重复计算", () => {
    let calls = 0;
    const fn = memoizeWithLRU(
      (x: number) => {
        calls++;
        return x + 1;
      },
      (x) => String(x),
      100,
    );
    expect(fn(1)).toBe(2);
    expect(fn(1)).toBe(2);
    expect(calls).toBe(1);
  });

  test("超容量驱逐最久未使用", () => {
    const fn = memoizeWithLRU(
      (x: number) => x,
      (x) => String(x),
      2,
    );
    fn(1);
    fn(2);
    fn(1); // 访问 1，使其变为最近使用
    fn(3); // 容量 2，应驱逐最久未使用的 2

    expect(fn.cache.has("1")).toBe(true);
    expect(fn.cache.has("3")).toBe(true);
    expect(fn.cache.has("2")).toBe(false);
    expect(fn.cache.size()).toBe(2);
  });

  test("clear / delete", () => {
    const fn = memoizeWithLRU(
      (x: number) => x,
      (x) => String(x),
      10,
    );
    fn(1);
    fn(2);
    expect(fn.cache.delete("1")).toBe(true);
    expect(fn.cache.has("1")).toBe(false);
    fn.cache.clear();
    expect(fn.cache.size()).toBe(0);
  });
});
