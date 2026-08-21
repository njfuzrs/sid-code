/**
 * model-lookup.ts — 「registry 精确 → 采集精确 → registry 模糊」三段阶梯的单测。
 *
 * 这个函数是 D3 剩余调用点迁移（PR9）抽出来的共用层：`fallback.ts` 两处钳制
 * 与 `query/loop.ts` 的截断续写 Stage 1 都要按真名解析 `maxOutputTokens`，
 * 原先各自写一次 `lookupRegistry(x)`（内含六级模糊瀑布），于是采集到的真值
 * 会被手写表的前缀猜测盖掉。
 *
 * 用例锁的是**顺序**而不是某个具体数字：顺序错了不报错、测试也能全绿，
 * 只是钳制会用一个偏小的猜测值 —— 正是那类「不报错的错数字」。
 *
 * 落盘隔离：全部走 `__resetCapabilityCacheForTest`（它同时置位 persistDisabled），
 * 否则会抹掉用户真实的 `~/.sid-code/model-capabilities.json`（有事故记录）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveRegistryMaxOutputTokens } from "@sid-code/core/llm/model-lookup.ts";
import { __resetCapabilityCacheForTest } from "@sid-code/core/llm/model-capabilities.ts";

beforeEach(() => {
  __resetCapabilityCacheForTest({});
});

afterEach(() => {
  __resetCapabilityCacheForTest({});
});

describe("resolveRegistryMaxOutputTokens — 三段顺序", () => {
  test("第 1 段：registry 精确命中直接返回，不看采集缓存", () => {
    // 采集缓存里塞一个不同的值：精确段必须赢，否则第三方数据会盖掉手写表的精确键。
    __resetCapabilityCacheForTest({ "glm-5.2": { maxOutputTokens: 999, source: "catalog" } });
    expect(resolveRegistryMaxOutputTokens("glm-5.2")).toBe(128_000);
  });

  test("第 2 段：registry 精确 miss → 采集精确命中（这一段是修复的核心）", () => {
    // glm-5.3 不在 registry 里，但 startsWith glm-5 → 模糊层能命中 glm-5。
    // 采集值必须赢，否则就退回「用猜的盖掉真的」那个 bug。
    __resetCapabilityCacheForTest({ "glm-5.3": { maxOutputTokens: 64_000, source: "catalog" } });
    expect(resolveRegistryMaxOutputTokens("glm-5.3")).toBe(64_000);
  });

  test("第 3 段：两层精确全 miss → registry 模糊兜底（不是直接 undefined）", () => {
    expect(resolveRegistryMaxOutputTokens("glm-5.3")).toBe(128_000); // 前缀借 glm-5
  });

  test("三段全 miss → undefined（**不臆测数字**）", () => {
    // 编一个数字会被下游当成「已知事实」参与钳制，比明确的 undefined 更危险。
    expect(resolveRegistryMaxOutputTokens("totally-made-up-model-xyz")).toBeUndefined();
  });
});

describe("resolveRegistryMaxOutputTokens — 数值校验", () => {
  test("采集缓存里的非法值不算命中，继续往下走模糊层", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      __resetCapabilityCacheForTest({
        "glm-5.3": { maxOutputTokens: bad as number, source: "catalog" },
      });
      // 非法值被跳过 → 落到模糊层的 glm-5（128K），而不是返回 0/NaN/Infinity。
      expect(resolveRegistryMaxOutputTokens("glm-5.3")).toBe(128_000);
    }
  });

  test("⚠ Infinity 必须被挡住 —— `> 0` 单独判会放行它，钳制就永久失效", () => {
    __resetCapabilityCacheForTest({
      "no-such-base-model": { maxOutputTokens: Number.POSITIVE_INFINITY, source: "catalog" },
    });
    // registry 三段都借不到 → 必须是 undefined（不钳制），绝不能返回 Infinity
    // （`maxTokens > Infinity` 恒 false → 看起来"钳制过了"，实际从不生效）。
    expect(resolveRegistryMaxOutputTokens("no-such-base-model")).toBeUndefined();
  });
});

describe("resolveRegistryMaxOutputTokens — 调用契约", () => {
  test("按真名查：喂本地别名会全 miss（调用方必须先解析别名）", () => {
    // 这不是缺陷而是契约：函数不持有 availableModels，无从解析别名。
    // 三个调用点都在外面先过 resolveWireModel / lookupWireModelAlias。
    expect(resolveRegistryMaxOutputTokens("claude-sonnet-5-gateway")).toBeUndefined();
  });

  test("采集缓存键大小写不敏感（lookupCapability 内部归一化）", () => {
    __resetCapabilityCacheForTest({ "glm-5.3": { maxOutputTokens: 64_000, source: "catalog" } });
    expect(resolveRegistryMaxOutputTokens("GLM-5.3")).toBe(64_000);
  });
});
