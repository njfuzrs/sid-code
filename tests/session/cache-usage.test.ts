/**
 * 缓存用量归一化（normalizeCacheUsage）+ 计费口径（calculateCost）测试
 *
 * 覆盖方案 §2.2 / §2.3 的核心修复：
 * - Anthropic 口径：inputTokens 已是未命中余量，勿再减
 * - OpenAI/DeepSeek 口径：inputTokens = prompt_tokens 含命中，需减出 uncached
 * - calculateCost 三段分别计价，不再用减法导致重复扣减
 */

import { describe, test, expect } from "bun:test";
import { normalizeCacheUsage, accumulateUsage } from "../../src/llm/types.ts";
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

  test("未知模型不静默归零，用保守兜底价估算（P1-4）", () => {
    const ss = new SessionState("test");
    // P1-4：未知模型不再返回 0（否则换个模型名费用立刻变 0，costLimit 守卫被绕过）。
    // 用保守兜底价（input $2/M、output $10/M）估算：100/1e6*2 + 10/1e6*10 = 0.0003
    const cost = ss.calculateCost("unknown-model", { inputTokens: 100, outputTokens: 10 });
    expect(cost).toBeCloseTo((100 / 1e6) * 2 + (10 / 1e6) * 10, 10);
    expect(cost).toBeGreaterThan(0);
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

  test("本地 provider（ollama）计费恒 0，不被 FALLBACK_PRICING 误算（P2-2）", () => {
    const ss = new SessionState("test");
    // 本地模型名（llama3）不在定价表，旧逻辑会走兜底价算出真金白银费用并误触 costLimit。
    // 显式 provider="ollama" 时应恒 0。
    const cost = ss.calculateCost("llama3", { inputTokens: 100000, outputTokens: 5000 }, "ollama");
    expect(cost).toBe(0);
    // 本地无费用即无"节省"
    const savings = ss.calculateSavings("llama3", { inputTokens: 100000, outputTokens: 5000, cacheReadInputTokens: 50000 }, "ollama");
    expect(savings).toBe(0);
  });

  test("isLocalProvider 识别常见本地 provider（P2-2）", () => {
    expect(SessionState.isLocalProvider("ollama")).toBe(true);
    expect(SessionState.isLocalProvider("Ollama")).toBe(true);
    expect(SessionState.isLocalProvider("lmstudio")).toBe(true);
    expect(SessionState.isLocalProvider("openai")).toBe(false);
    expect(SessionState.isLocalProvider("anthropic")).toBe(false);
    expect(SessionState.isLocalProvider(undefined)).toBe(false);
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

  test("P1-3：多轮 OpenAI 口径下命中率用累加输入(flow)而非末次(stock)", () => {
    // OpenAI/DeepSeek 的 inputTokens 是含命中的全量 prompt。多轮后累加命中(flow)
    // 会远超末次输入(stock)。若 normalize 用末次输入，uncached=max(0,input−hit) 被钳到 0，
    // promptTotal 也会塌缩。必须用 cumulativePromptTokens(flow)。
    const ss = new SessionState("test");
    // 3 轮，每轮末次输入 6000、命中 5000；累加输入应为 18000、累加命中 15000
    for (let i = 0; i < 3; i++) {
      ss.updateUsage(
        "deepseek-v4-pro",
        { inputTokens: 6000, outputTokens: 200, cacheReadInputTokens: 5000 },
        100,
        "openai",
      );
    }
    const n = ss.getNormalizedCacheUsage();
    expect(n.cacheHitTokens).toBe(15000);              // 累加命中
    expect(n.promptTotal).toBe(18000);                 // 累加输入(flow)，非末次 6000
    expect(n.uncachedInputTokens).toBe(3000);          // 18000 − 15000，未被钳 0
    // 命中率 = 15000/18000 ≈ 83%，而非用末次输入算出的虚高值
    expect(n.cacheHitTokens / n.promptTotal).toBeCloseTo(15000 / 18000, 6);
  });

  test("getCumulativePromptTokens 跨模型累加各自 flow 值", () => {
    const ss = new SessionState("test");
    ss.updateUsage("deepseek-v4-pro", { inputTokens: 6000, outputTokens: 200 }, 100, "openai");
    ss.updateUsage("deepseek-v4-pro", { inputTokens: 7000, outputTokens: 200 }, 100, "openai");
    ss.updateUsage("claude-sonnet-4-20250514", { inputTokens: 1000, outputTokens: 100 }, 100, "anthropic");
    // deepseek flow = 13000，claude flow = 1000
    expect(ss.getCumulativePromptTokens()).toBe(14000);
    // 末次值(stock)各取最后一次：deepseek 7000 + claude 1000 = 8000
    expect(ss.getTotalUsage().inputTokens).toBe(8000);
  });
});

describe("accumulateUsage — 单一权威累加（P0/P1-2）", () => {
  test("累加 input/output 并仅在提供时累加缓存字段", () => {
    const target: Usage = { inputTokens: 0, outputTokens: 0 };
    accumulateUsage(target, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50 });
    accumulateUsage(target, { inputTokens: 0, outputTokens: 20, cacheCreationInputTokens: 30 });
    expect(target.inputTokens).toBe(100);
    expect(target.outputTokens).toBe(30);
    expect(target.cacheReadInputTokens).toBe(50);
    expect(target.cacheCreationInputTokens).toBe(30);
  });

  test("undefined 事件 usage 不污染目标", () => {
    const target: Usage = { inputTokens: 5, outputTokens: 5 };
    accumulateUsage(target, undefined);
    expect(target.inputTokens).toBe(5);
    expect(target.outputTokens).toBe(5);
  });

  test("缓存字段为 undefined 时不当作 0 写入（保持 undefined 不污染）", () => {
    const target: Usage = { inputTokens: 0, outputTokens: 0 };
    accumulateUsage(target, { inputTokens: 100, outputTokens: 10 });
    expect(target.cacheReadInputTokens).toBeUndefined();
    expect(target.cacheCreationInputTokens).toBeUndefined();
  });
});
