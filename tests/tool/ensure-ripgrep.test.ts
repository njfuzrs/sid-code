/**
 * ripgrep 嵌入释放层单测
 * 覆盖：dev 模式回退（不释放）、并发单例缓存
 *
 * 注：bun test 直接跑 .ts 源码（非编译产物），IS_DEV_MODE 恒为 true，
 * 因此 ensureRipgrepReleased() 在测试环境下总是走「dev 回退」分支返回 null。
 * 编译产物下的真实释放（哈希幂等 / chmod / 原子写）留给端到端验证
 * （见 verify 环节：临时隐藏系统 rg，跑编译产物确认能从嵌入释放并搜索）。
 */

import { describe, test, expect } from "bun:test";
import {
  ensureRipgrepReleased,
  __resetRipgrepReleaseCacheForTest,
} from "../../src/tool/ensure-ripgrep.ts";

describe("ensureRipgrepReleased", () => {
  test("dev 模式下直接返回 null（不尝试释放，调用方回退系统 rg）", async () => {
    __resetRipgrepReleaseCacheForTest();
    const result = await ensureRipgrepReleased();
    expect(result).toBeNull();
  });

  test("并发调用复用同一个 Promise（单例缓存，不重复触发释放逻辑）", async () => {
    __resetRipgrepReleaseCacheForTest();
    const [a, b, c] = await Promise.all([
      ensureRipgrepReleased(),
      ensureRipgrepReleased(),
      ensureRipgrepReleased(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("重置缓存后可重新解析", async () => {
    __resetRipgrepReleaseCacheForTest();
    const first = await ensureRipgrepReleased();
    __resetRipgrepReleaseCacheForTest();
    const second = await ensureRipgrepReleased();
    // dev 模式下两次都应为 null，但关键是重置后确实重新走了一次 doRelease()
    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
