import { describe, expect, test } from "bun:test";
import { memoize } from "../../src/utils/memoize.ts";

describe("memoize 增强", () => {
  test("异步函数只执行一次", async () => {
    let calls = 0;
    const fn = memoize(async () => {
      calls++;
      return 42;
    });
    expect(await fn()).toBe(42);
    expect(await fn()).toBe(42);
    expect(calls).toBe(1);
  });

  test("clear 后重新执行", async () => {
    let calls = 0;
    const fn = memoize(async () => {
      calls++;
      return calls;
    });
    expect(await fn()).toBe(1);
    fn.clear();
    expect(await fn()).toBe(2);
    expect(calls).toBe(2);
  });

  test("cache 暴露单 slot，可外部预热", async () => {
    let calls = 0;
    const fn = memoize(async () => {
      calls++;
      return "real";
    });
    // 预热：直接写入 cache slot
    fn.cache.set(undefined, Promise.resolve("warmed"));
    expect(await fn()).toBe("warmed");
    expect(calls).toBe(0); // 未触发真实执行
  });

  test("带参数函数共享单 slot（参数不参与缓存键）", async () => {
    let calls = 0;
    const fn = memoize(async (x: number) => {
      calls++;
      return x * 2;
    });
    expect(await fn(5)).toBe(10);
    expect(await fn(99)).toBe(10); // 仍返回首次结果
    expect(calls).toBe(1);
  });
});
