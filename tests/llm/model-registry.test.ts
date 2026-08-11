/**
 * model-registry.ts — lookupRegistry 五级匹配策略测试
 *
 * lookupRegistry 是全库模型参数（contextWindow / maxOutputTokens / 协议能力）
 * 与定价的唯一事实源，被 token-estimator / cost-tracker / model-params-catalog /
 * discover 共同消费。其五级匹配（精确 → 最长前缀 → "/" 路由剥离 → 供应商连字符
 * 前缀剥离 → 大小写不敏感 → 家族匹配）在新增/改名模型时极易被误改坏，此处直接
 * 锁住每级策略的边界行为，防止回归。
 */

import { describe, test, expect } from "bun:test";
import { lookupRegistry } from "@sid-code/core/llm/model-registry.ts";

describe("lookupRegistry 匹配策略", () => {
  // ── 1. 精确匹配 ──────────────────────────────────────────────
  describe("精确匹配", () => {
    test("已知模型返回完整条目", () => {
      const entry = lookupRegistry("claude-opus-4-8");
      expect(entry?.contextWindow).toBe(1_000_000);
      expect(entry?.maxOutputTokens).toBe(128_000);
      expect(entry?.protocolKind).toBe("anthropic-native");
    });

    test("完全未知模型返回 null", () => {
      expect(lookupRegistry("totally-made-up-model")).toBeNull();
    });
  });

  // ── 2. 最长前缀匹配 ──────────────────────────────────────────
  describe("最长前缀匹配", () => {
    test("变体后缀命中前缀（deepseek-v4-flash-maxthink → deepseek-v4-flash）", () => {
      const entry = lookupRegistry("deepseek-v4-flash-maxthink");
      expect(entry?.contextWindow).toBe(1_000_000);
      expect(entry?.maxOutputTokens).toBe(384_000);
    });

    test("命中的是最长前缀而非最短（deepseek-v4-pro 不退化到更短的 key）", () => {
      // 若存在 "deepseek" 与 "deepseek-v4-pro" 两个 key，应取更长者。
      // 这里 deepseek-v4-pro-xxx 应命中 deepseek-v4-pro（384K），
      // 而非任何更短前缀。
      const entry = lookupRegistry("deepseek-v4-pro-experimental");
      expect(entry?.maxOutputTokens).toBe(384_000);
      expect(entry?.requiresReasoningContentForToolCalls).toBe(true);
    });
  });

  // ── 3. "/" 路由前缀剥离 ──────────────────────────────────────
  describe('"/" 路由前缀剥离', () => {
    test("kim/kimi-k2.6 → kimi-k2.6", () => {
      const entry = lookupRegistry("kim/kimi-k2.6");
      expect(entry?.contextWindow).toBe(262_144);
    });

    test('"/" 剥离后走前缀匹配（openrouter/deepseek-v4-flash-x → deepseek-v4-flash）', () => {
      const entry = lookupRegistry("openrouter/deepseek-v4-flash-x");
      expect(entry?.maxOutputTokens).toBe(384_000);
    });
  });

  // ── 3.5 供应商连字符前缀白名单剥离 ───────────────────────────
  describe("供应商连字符前缀剥离（白名单）", () => {
    test("ali-deepseek-v4-pro → deepseek-v4-pro", () => {
      const entry = lookupRegistry("ali-deepseek-v4-pro");
      expect(entry?.contextWindow).toBe(1_000_000);
      expect(entry?.pricing?.input).toBe(0.435);
    });

    test("volc-deepseek-v4-flash → deepseek-v4-flash", () => {
      const entry = lookupRegistry("volc-deepseek-v4-flash");
      expect(entry?.maxOutputTokens).toBe(384_000);
    });

    test("siliconflow- 前缀剥离命中", () => {
      const entry = lookupRegistry("siliconflow-deepseek-chat");
      expect(entry?.contextWindow).toBe(1_000_000);
    });

    test("非白名单前缀不剥离，避免误伤正规连字符模型名", () => {
      // "claude-" / "gpt-" / "glm-" / "grok-" 本就以连字符构成，
      // 绝不能被当作路由前缀盲目剥离。这里构造一个不在表中且前缀不在白名单的名字，
      // 应返回 null 而非误命中。
      expect(lookupRegistry("myvendor-nonexistent-model")).toBeNull();
    });

    test("白名单前缀剥离后仍未命中则返回 null", () => {
      expect(lookupRegistry("ali-nonexistent-model-xyz")).toBeNull();
    });
  });

  // ── 4. 大小写不敏感匹配 ──────────────────────────────────────
  describe("大小写不敏感匹配", () => {
    test("CLAUDE-OPUS-4-8 命中 claude-opus-4-8", () => {
      const entry = lookupRegistry("CLAUDE-OPUS-4-8");
      expect(entry?.contextWindow).toBe(1_000_000);
    });
  });

  // ── 5. 家族匹配（剥离尾部日期/版本号） ───────────────────────
  describe("家族匹配", () => {
    test("未知日期后缀命中同家族基名（claude-sonnet-4-20260101 → claude-sonnet-4 家族）", () => {
      // 表中 claude-sonnet-4-20250514 的 familyBase = claude-sonnet-4
      const entry = lookupRegistry("claude-sonnet-4-20260101");
      expect(entry?.contextWindow).toBe(200_000);
    });

    test("家族匹配不误伤版本号命名（-4-6 不被当作日期剥离）", () => {
      // claude-sonnet-4-6 的 familyBase 仍是 claude-sonnet-4-6（4-6 非 4 位以上数字），
      // 精确命中自身的 1M 条目，绝不退化到 claude-sonnet-4 的 200K。
      const entry = lookupRegistry("claude-sonnet-4-6");
      expect(entry?.contextWindow).toBe(1_000_000);
    });
  });

  // ── 关键回归：opus-4.8 绝不被当 200K ─────────────────────────
  test("回归锁：claude-opus-4-8 必为 1M（防双表漂移复发）", () => {
    // 历史上 token-estimator 与 catalog 双表独立维护曾使 1M 模型被静默当 200K。
    // 统一到 registry 单一事实源后，此断言锁住 opus-4.8 的 1M 窗口不再退化。
    expect(lookupRegistry("claude-opus-4-8")?.contextWindow).toBe(1_000_000);
  });
});
