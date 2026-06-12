/**
 * 缓存用量归一化（normalizeCacheUsage）+ 计费口径（calculateCost）测试
 *
 * 覆盖方案 §2.2 / §2.3 的核心修复：
 * - Anthropic 口径：inputTokens 已是未命中余量，勿再减
 * - OpenAI/DeepSeek 口径：inputTokens = prompt_tokens 含命中，需减出 uncached
 * - calculateCost 三段分别计价，不再用减法导致重复扣减
 */

import { describe, test, expect } from "bun:test";
import { normalizeCacheUsage } from "../../src/llm/types.ts";
import type { Usage } from "../../src/llm/types.ts";
import { SessionState } from "../../src/session/state.ts";

describe("normalizeCacheUsage", () => {
  test("Anthropic：inputTokens 即未命中余量，promptTotal = input + hit + write", () => {
    const usage: Usage = {
      inputTokens: 1000,           // Anthropic input_tokens = 未命中余量
      outputTokens: 200,
      cacheReadInputTokens: 5000,  // 命中
      cacheCreationInputTokens: 300, // 写入
    };
    const n = normalizeCacheUsage(usage, "anthropic");
    expect(n.uncachedInputTokens).toBe(1000);
    expect(n.cacheHitTokens).toBe(5000);
    expect(n.cacheWriteTokens).toBe(300);
    expect(n.outputTokens).toBe(200);
    expect(n.promptTotal).toBe(1000 + 5000 + 300);
  });

  test("DeepSeek/OpenAI：inputTokens = prompt_tokens 含命中，uncached = input − hit", () => {
    const usage: Usage = {
      inputTokens: 6000,           // prompt_tokens（含命中）
      outputTokens: 200,
      cacheReadInputTokens: 5000,  // 其中命中
      // DeepSeek 无写入
    };
    const n = normalizeCacheUsage(usage, "openai");
    expect(n.uncachedInputTokens).toBe(1000); // 6000 − 5000
    expect(n.cacheHitTokens).toBe(5000);
    expect(n.cacheWriteTokens).toBe(0);
    expect(n.promptTotal).toBe(6000); // prompt_tokens 本就是完整输入
  });

  test("无缓存字段（ollama 等）：三段退化为 uncached = input", () => {
    const usage: Usage = { inputTokens: 800, outputTokens: 100 };
    const n = normalizeCacheUsage(usage, "ollama");
    expect(n.cacheHitTokens).toBe(0);
    expect(n.cacheWriteTokens).toBe(0);
    expect(n.uncachedInputTokens).toBe(800);
    expect(n.promptTotal).toBe(800);
  });

  test("命中数异常大于 prompt_tokens 时 uncached 不为负", () => {
    const usage: Usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 5000,
    };
    const n = normalizeCacheUsage(usage, "openai");
    expect(n.uncachedInputTokens).toBe(0); // Math.max(0, 100 − 5000)
  });
});

describe("SessionState.inferProvider", () => {
  test("claude* → anthropic", () => {
    expect(SessionState.inferProvider("claude-sonnet-4-20250514")).toBe("anthropic");
    expect(SessionState.inferProvider("claude-opus-4-20250514")).toBe("anthropic");
  });
  test("其余 → openai 口径", () => {
    expect(SessionState.inferProvider("deepseek-v4-pro")).toBe("openai");
    expect(SessionState.inferProvider("gpt-4o")).toBe("openai");
  });
});

describe("SessionState.calculateCost — 口径修复", () => {
  test("Anthropic：命中不被重复扣减（修复前 regularInput 偏小 bug）", () => {
    const ss = new SessionState("test");
    // Anthropic：input=1000(未命中) + 命中 5000 + 写入 300
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 300,
    };
    const cost = ss.calculateCost("claude-sonnet-4-20250514", usage, "anthropic");
    // sonnet: input=3, output=15, cacheHit=3*0.1=0.3, cacheWrite=3*1.25=3.75（兜底派生）
    const expected =
      (1000 / 1e6) * 3 +        // 未命中
      (5000 / 1e6) * 0.3 +      // 命中
      (300 / 1e6) * 3.75 +      // 写入
      (200 / 1e6) * 15;         // 输出
    expect(cost).toBeCloseTo(expected, 10);
  });

  test("DeepSeek：prompt_tokens 含命中，用 uncached 全价 + 命中固定价", () => {
    const ss = new SessionState("test");
    const usage: Usage = {
      inputTokens: 6000,          // prompt_tokens
      outputTokens: 200,
      cacheReadInputTokens: 5000, // 命中
    };
    const cost = ss.calculateCost("deepseek-v4-pro", usage, "openai");
    // deepseek-v4-pro: input=0.42, output=0.84, cacheHit=0.0035, cacheWrite=0
    const expected =
      (1000 / 1e6) * 0.42 +    // uncached = 6000 − 5000
      (5000 / 1e6) * 0.0035 +  // 命中固定价
      (200 / 1e6) * 0.84;      // 输出
    expect(cost).toBeCloseTo(expected, 10);
  });

  test("未知模型返回 0", () => {
    const ss = new SessionState("test");
    expect(ss.calculateCost("unknown-model", { inputTokens: 100, outputTokens: 10 })).toBe(0);
  });

  test("calculateSavings：命中越多省钱越多，且非负", () => {
    const ss = new SessionState("test");
    const noCacheUsage: Usage = { inputTokens: 6000, outputTokens: 200 };
    const cachedUsage: Usage = { inputTokens: 6000, outputTokens: 200, cacheReadInputTokens: 5000 };
    const savingsNone = ss.calculateSavings("deepseek-v4-pro", noCacheUsage, "openai");
    const savingsCached = ss.calculateSavings("deepseek-v4-pro", cachedUsage, "openai");
    expect(savingsNone).toBe(0);
    expect(savingsCached).toBeGreaterThan(0);
  });
});

describe("SessionState.getNormalizedCacheUsage — 会话级汇总", () => {
  test("跨模型累加三段，promptTotal 一致", () => {
    const ss = new SessionState("test");
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 6000, outputTokens: 200, cacheReadInputTokens: 5000 },
      100,
      "openai",
    );
    ss.updateUsage(
      "claude-sonnet-4-20250514",
      { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 2000, cacheCreationInputTokens: 100 },
      100,
      "anthropic",
    );
    const n = ss.getNormalizedCacheUsage();
    // deepseek: hit 5000, uncached 1000, prompt 6000
    // claude:   hit 2000, write 100, uncached 1000, prompt 3100
    expect(n.cacheHitTokens).toBe(7000);
    expect(n.cacheWriteTokens).toBe(100);
    expect(n.uncachedInputTokens).toBe(2000);
    expect(n.promptTotal).toBe(6000 + 3100);
  });

  test("getTotalCacheSavings 跨模型累加", () => {
    const ss = new SessionState("test");
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 6000, outputTokens: 200, cacheReadInputTokens: 5000 },
      100,
      "openai",
    );
    expect(ss.getTotalCacheSavings()).toBeGreaterThan(0);
  });
});
