/**
 * 缓存用量归一化（normalizeCacheUsage）+ 计费口径（calculateCost）测试
 *
 * 覆盖方案 §2.2 / §2.3 的核心修复：
 * - Anthropic 口径：inputTokens 已是未命中余量，勿再减
 * - OpenAI/DeepSeek 口径：inputTokens = prompt_tokens 含命中，需减出 uncached
 * - calculateCost 三段分别计价，不再用减法导致重复扣减
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCacheUsage, accumulateUsage } from "@sid-code/core/llm/types.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { __resetGatewayPricingForTest } from "@sid-code/core/llm/gateway-pricing.ts";

// 隔离：把配置目录指向空临时目录，避免 deepseek-v4-pro 计费断言读到本机真实网关缓存
// （渠道价会覆盖注册表价，dev 机必挂）。gateway-pricing 有模块级内存缓存，需一并重置。
let __tmpCfg: string;
let __prevCfg: string | undefined;
beforeAll(() => {
  __prevCfg = process.env.SID_CONFIG_DIR;
  __tmpCfg = mkdtempSync(join(tmpdir(), "cache-usage-cfg-"));
  process.env.SID_CONFIG_DIR = __tmpCfg;
  __resetGatewayPricingForTest();
});
afterAll(() => {
  if (__prevCfg === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = __prevCfg;
  __resetGatewayPricingForTest();
  try { rmSync(__tmpCfg, { recursive: true, force: true }); } catch { /* ignore */ }
});

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
    // deepseek-v4-pro: input=0.435, output=0.87, cacheHit=0.0036, cacheWrite=0
    const expected =
      (1000 / 1e6) * 0.435 +   // uncached = 6000 − 5000
      (5000 / 1e6) * 0.0036 +  // 命中固定价
      (200 / 1e6) * 0.87;      // 输出
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
    // DISP-1 FIX：getTotalUsage().inputTokens 现也改为 flow 累计口径，与此一致
    expect(ss.getCumulativePromptTokens()).toBe(14000);
    expect(ss.getTotalUsage().inputTokens).toBe(14000);
  });
});

describe("SessionState.getStockPromptTokens — 末次完整输入(stock)", () => {
  test("Anthropic：stock 取末次归一化 promptTotal(含命中)，而非裸 input_tokens", () => {
    // 缓存预热后 Anthropic 每次 input_tokens 只剩未命中余量，大头在 cache_read。
    // 状态栏「输入」要反映当前上下文 → 必须用 promptTotal = input + hit + write，
    // 而非 getStockInputTokens()(裸 input_tokens)，否则严重低估上下文大小。
    const ss = new SessionState("test");
    // 第 1 轮：冷启动，命中为 0
    ss.updateUsage(
      "claude-sonnet-4-20250514",
      { inputTokens: 50000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 1000 },
      100,
      "anthropic",
    );
    // 第 2 轮：缓存预热，input_tokens 骤降至 2500(未命中余量)，命中 80000
    ss.updateUsage(
      "claude-sonnet-4-20250514",
      { inputTokens: 2500, outputTokens: 200, cacheReadInputTokens: 80000, cacheCreationInputTokens: 500 },
      100,
      "anthropic",
    );
    // stock 完整输入 = 末次 promptTotal = 2500(未命中) + 80000(命中) + 500(写入) = 83000
    expect(ss.getStockPromptTokens()).toBe(83000);
    // 对照：裸 input_tokens(旧口径)只有 2500，会把 83k 的上下文显示成 2.5k → 严重低估
    expect(ss.getStockInputTokens()).toBe(2500);
  });

  test("DeepSeek/OpenAI：prompt_tokens 本就含命中，stock = 末次 prompt_tokens", () => {
    const ss = new SessionState("test");
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 6000, outputTokens: 200, cacheReadInputTokens: 1000 },
      100,
      "openai",
    );
    // 末次 prompt_tokens 含命中 → stock 完整输入 = 6000(promptTotal 直接取 input)
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 18000, outputTokens: 200, cacheReadInputTokens: 15000 },
      100,
      "openai",
    );
    expect(ss.getStockPromptTokens()).toBe(18000);
    // DeepSeek 下裸 input_tokens 与 promptTotal 一致(都含命中)，两口径相等
    expect(ss.getStockInputTokens()).toBe(18000);
  });

  test("stock 是末次值(覆盖)，不随轮次 N² 膨胀", () => {
    const ss = new SessionState("test");
    // 3 轮，每轮末次完整输入递增；stock 应为最后一轮值，而非累加
    ss.updateUsage("claude-sonnet-4-20250514", { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 10000 }, 100, "anthropic");
    ss.updateUsage("claude-sonnet-4-20250514", { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 30000 }, 100, "anthropic");
    ss.updateUsage("claude-sonnet-4-20250514", { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 60000 }, 100, "anthropic");
    // 末次 = 1000 + 60000 = 61000，不是 3 轮累加(会 N² 膨胀)
    expect(ss.getStockPromptTokens()).toBe(61000);
    // 对照 flow：cumulativePromptTokens 累加 = 3 × 1000 = 3000(Anthropic 累加未命中余量)
    expect(ss.getCumulativePromptTokens()).toBe(3000);
  });

  test("多模型会话：stock 各模型末次完整输入简单求和", () => {
    const ss = new SessionState("test");
    ss.updateUsage("claude-sonnet-4-20250514", { inputTokens: 2000, outputTokens: 100, cacheReadInputTokens: 40000, cacheCreationInputTokens: 1000 }, 100, "anthropic");
    ss.updateUsage("deepseek-v4-pro", { inputTokens: 12000, outputTokens: 100, cacheReadInputTokens: 8000 }, 100, "openai");
    // claude 末次 promptTotal = 2000 + 40000 + 1000 = 43000；deepseek = 12000
    expect(ss.getStockPromptTokens()).toBe(43000 + 12000);
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

// §五（fdb47f30）：/clear 调用 SessionState.resetCounters() 清零状态栏统计。
// 验证累积用量后 resetCounters 把 token/费用/modelUsage 全部归零。
describe("SessionState.resetCounters — /clear 状态栏清空", () => {
  test("累积用量后 resetCounters 清零 token/费用/modelUsage", () => {
    const ss = new SessionState("test-clear");
    // 模拟两次 API 调用累积用量
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500 } as Usage,
      1200,
    );
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1500, outputTokens: 300 } as Usage,
      900,
    );

    // 清空前：确有累积
    expect(ss.totalCostUSD).toBeGreaterThanOrEqual(0); // 费用按定价表，可能为 0（本地）或正
    expect(Object.keys(ss.modelUsage).length).toBe(1);
    expect(ss.getTotalUsage().outputTokens).toBe(500);

    // 执行 /clear 的清零
    ss.resetCounters();

    // 清空后：状态栏三件套全部归零
    expect(ss.totalCostUSD).toBe(0);
    expect(Object.keys(ss.modelUsage).length).toBe(0);
    expect(ss.getTotalUsage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(ss.getStockPromptTokens()).toBe(0);
  });
});

describe("辅助调用费用（sideCostUSD）", () => {
  test("addSideCost 累加到 sideCostUSD，不影响 totalCostUSD 和 modelUsage", () => {
    const ss = new SessionState("test-side");
    ss.updateUsage("deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 } as Usage, 500, "openai");
    const mainCost = ss.totalCostUSD;

    ss.addSideCost(0.05);
    ss.addSideCost(0.03);

    // sideCostUSD 独立累加
    expect(ss.sideCostUSD).toBeCloseTo(0.08, 6);
    // totalCostUSD 不受影响（仍是主循环口径）
    expect(ss.totalCostUSD).toBe(mainCost);
    // modelUsage 不被辅助调用污染（stock 口径不变，保证"当前上下文大小"展示正确）
    expect(Object.keys(ss.modelUsage).length).toBe(1);
    expect(ss.modelUsage["deepseek-v4-pro"].inputTokens).toBe(1000);
  });

  test("getEffectiveTotalCostUSD = 主循环 + 辅助调用", () => {
    const ss = new SessionState("test-eff");
    ss.updateUsage("deepseek-v4-pro", { inputTokens: 2000, outputTokens: 200 } as Usage, 500, "openai");
    const mainCost = ss.totalCostUSD;
    ss.addSideCost(0.1);

    expect(ss.getEffectiveTotalCostUSD()).toBeCloseTo(mainCost + 0.1, 6);
  });

  test("resetCounters 同时清零 sideCostUSD", () => {
    const ss = new SessionState("test-reset-side");
    ss.addSideCost(0.2);
    expect(ss.sideCostUSD).toBeCloseTo(0.2, 6);

    ss.resetCounters();

    expect(ss.sideCostUSD).toBe(0);
    expect(ss.getEffectiveTotalCostUSD()).toBe(0);
  });
});
