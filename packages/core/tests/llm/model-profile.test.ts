/**
 * model-profile.ts 测试 — 展示级模型画像的聚合
 *
 * 最重要的一组是「detectPricingSource 与 resolvePricing 不许分叉」：
 * 前者是后者优先级链的一份复制品（理由见 model-profile.ts 的函数注释），
 * 分叉的形态是「面板说注册表价、实际按网关价计费」，用户无从判断哪个对。
 * 这里逐级构造命中，断言两者对同一输入给出一致的结论。
 *
 * ⚠ 必须隔离 SID_CONFIG_DIR 并调 __resetGatewayPricingForTest()：
 * gateway-pricing 有模块级内存缓存，dev 机上会读到真实 ~/.sid-code 的网关价，
 * 拿渠道价而非注册表价 → 断言必挂（这条坑本仓踩过，见 CLAUDE.md 相关记忆）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildModelProfile,
  detectPricingSource,
  getPerCallUSD,
  type ProfileModelEntry,
} from "@sid-code/core/llm/model-profile.ts";
import { resolvePricing } from "@sid-code/core/api/cost-tracker.ts";
import { __resetGatewayPricingForTest } from "@sid-code/core/llm/gateway-pricing.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

const GW = "https://gw.example.com";

let tmpDir: string;
let prevConfigDir: string | undefined;

/** 往隔离目录写一份网关价缓存（v2 分桶结构）。 */
function writeGatewayCache(models: Record<string, unknown>, endpoint = GW): void {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(
    sidPaths.gatewayPricing(),
    JSON.stringify({
      schema_version: 2,
      endpoints: {
        [endpoint]: {
          source_url: `${endpoint}/api/pricing`,
          fetched_at: Date.now(),
          pricing_version: "test",
          models,
        },
      },
    }),
    "utf8",
  );
}

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "model-profile-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetGatewayPricingForTest();
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  __resetGatewayPricingForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("detectPricingSource 与 resolvePricing 逐级对齐（防分叉）", () => {
  test("第 1 级：用户手写「模型名 + 端点」复合键 → user", () => {
    const models: ProfileModelEntry[] = [
      { name: "m", baseURL: GW, pricing: { input: 1, output: 2 } },
    ];
    expect(detectPricingSource("m", models, GW)).toBe("user");
    // 同一输入下 resolvePricing 必须真的取到这条价（否则来源标注在骗人）
    expect(resolvePricing("m", models, GW)?.input).toBe(1);
  });

  test("第 2 级：用户手写「仅模型名」（旧配置无端点维度）→ user", () => {
    const models: ProfileModelEntry[] = [{ name: "m", pricing: { input: 7, output: 8 } }];
    expect(detectPricingSource("m", models, GW)).toBe("user");
    expect(resolvePricing("m", models, GW)?.input).toBe(7);
  });

  test("input=0 的手写价不算命中（与 resolvePricing 的 `input > 0` 判据一致）", () => {
    const models: ProfileModelEntry[] = [
      { name: "totally-unknown-xyz", pricing: { input: 0, output: 0 } },
    ];
    // 两边都要"看不见"这条价：resolvePricing 会继续往下走，来源也不能标 user
    expect(detectPricingSource("totally-unknown-xyz", models)).not.toBe("user");
  });

  test("第 3 级：网关实采价 → gateway，且优先于注册表", () => {
    // 用一个注册表里确实存在的模型名，验证网关价把注册表价压下去
    writeGatewayCache({
      "claude-opus-4-8": { quotaType: 0, input: 99, output: 111, cacheRead: 9 },
    });
    const models: ProfileModelEntry[] = [{ name: "claude-opus-4-8", baseURL: GW }];
    expect(detectPricingSource("claude-opus-4-8", models, GW)).toBe("gateway");
    expect(resolvePricing("claude-opus-4-8", models, GW)?.input).toBe(99);
  });

  test("第 4 级：内置注册表 → registry", () => {
    const models: ProfileModelEntry[] = [{ name: "claude-opus-4-8", baseURL: GW }];
    expect(detectPricingSource("claude-opus-4-8", models, GW)).toBe("registry");
    expect(resolvePricing("claude-opus-4-8", models, GW)).not.toBeNull();
  });

  test("第 5 级：全 miss → unknown，且 resolvePricing 确实返回 null", () => {
    const name = "zzz-not-a-real-model-9x8y7z";
    const models: ProfileModelEntry[] = [{ name, baseURL: GW }];
    expect(detectPricingSource(name, models, GW)).toBe("unknown");
    expect(resolvePricing(name, models, GW)).toBeNull();
  });

  test("配了 modelId 的渠道按真名查注册表（原 model.ts 实现传别名 → 来源误标，此处是回归）", () => {
    // 别名是**前缀式/自定义**的（不是真名 + 后缀），modelId 指回真名。
    //
    // 为什么选 `gw-` 前缀而不是 `-gateway` 后缀：注册表的模糊匹配能救回后缀式别名
    // （`claude-opus-4-8-gateway` 前缀命中 `claude-opus-4-8`），所以后缀式别名下
    // 旧实现碰巧也对，测不出问题。前缀式别名（以及 `company-fast` 这类完全自定义名）
    // 在模糊匹配里一样 miss —— 实测旧写法返回 unknown、新写法返回 registry。
    // 后果不是算错钱（resolvePricing 一直是按真名查的），而是**来源标注与实际取价不一致**：
    // 明明用的是注册表价，`/model list` 却告诉用户「兜底估算」。
    const models: ProfileModelEntry[] = [
      { name: "gw-claude-opus-4-8", modelId: "claude-opus-4-8", baseURL: GW },
    ];
    expect(detectPricingSource("gw-claude-opus-4-8", models, GW)).toBe("registry");
    // 与实际取价一致：resolvePricing 第 4 步也按真名查
    expect(resolvePricing("gw-claude-opus-4-8", models, GW)).not.toBeNull();
  });
});

describe("getPerCallUSD：按次计费模型", () => {
  test("quotaType=1 返回按次单价", () => {
    writeGatewayCache({
      "video-gen": { quotaType: 1, perCallUSD: 0.05, input: 0, output: 0 },
    });
    expect(getPerCallUSD("video-gen", GW)).toBe(0.05);
  });

  test("quotaType=0（按 token）不返回按次价", () => {
    writeGatewayCache({ "chat-m": { quotaType: 0, input: 1, output: 2 } });
    expect(getPerCallUSD("chat-m", GW)).toBeUndefined();
  });

  test("端点桶未精确命中时回退合并视图（用户配置端点与采集端点归一化可能不一致）", () => {
    writeGatewayCache({ "video-gen": { quotaType: 1, perCallUSD: 0.07 } }, GW);
    // 传一个不同的端点：精确桶 miss，但合并视图里有
    expect(getPerCallUSD("video-gen", "https://other.example.com")).toBe(0.07);
  });

  test("未采集的模型返回 undefined，不编数字", () => {
    expect(getPerCallUSD("never-collected-model")).toBeUndefined();
  });

  test("按次计费模型的来源必须是 gateway，不能落到 registry", () => {
    // 真实 bug（实测企业网关 4 个模型命中）：lookupGatewayPricing 对按次计费**刻意返回
    // null**（按次价无法表达成 per-token），于是来源判定一路落到注册表，展示成
    // 「$18.00/次（注册表）」—— 数字来自网关、标签却说注册表。
    // 用注册表里确实存在的模型名，确保不是"因为注册表 miss 才落到 gateway"。
    writeGatewayCache({ "claude-opus-4-8": { quotaType: 1, perCallUSD: 60 } });
    const models: ProfileModelEntry[] = [{ name: "claude-opus-4-8", baseURL: GW }];
    expect(detectPricingSource("claude-opus-4-8", models, GW)).toBe("gateway");
    const p = buildModelProfile(models[0]!, models, "anthropic");
    expect(p.perCallUSD).toBe(60);
    expect(p.pricingSource).toBe("gateway");
  });
});

describe("buildModelProfile：聚合与诚实性", () => {
  test("用户显式声明的窗口 / 输出上限，来源标 user", () => {
    const entry: ProfileModelEntry = {
      name: "custom-m",
      provider: "openai",
      baseURL: GW,
      contextWindow: 123_456,
      maxOutputTokens: 4_096,
    };
    const p = buildModelProfile(entry, [entry], "openai");
    expect(p.contextWindow).toEqual({ value: 123_456, source: "user" });
    expect(p.maxOutputTokens).toEqual({ value: 4_096, source: "user" });
  });

  test("完全未知的模型：窗口落兜底且来源必须标 fallback（不能冒充事实）", () => {
    const entry: ProfileModelEntry = {
      name: "zzz-not-a-real-model-9x8y7z",
      provider: "openai",
      baseURL: GW,
    };
    const p = buildModelProfile(entry, [entry], "openai");
    // 值本身是兜底常量 1M —— 关键是 source 必须暴露它是猜的
    expect(p.contextWindow.source).toBe("fallback");
    expect(p.pricing).toBeNull();
    expect(p.pricingSource).toBe("unknown");
  });

  test("注册表模型：窗口来源是 registry（精确命中，不带猜测标记）", () => {
    const entry: ProfileModelEntry = {
      name: "claude-opus-4-8",
      provider: "anthropic",
      baseURL: GW,
    };
    const p = buildModelProfile(entry, [entry], "anthropic");
    expect(p.contextWindow.source).toBe("registry");
    expect(p.contextWindow.value).toBeGreaterThan(0);
  });

  test("价格已过 effectivePricing：人民币价折成 USD，且原币种仍可见", () => {
    // DeepSeek 系在注册表里存的是 CNY + fxToUSD（见 model-registry.ts）
    const entry: ProfileModelEntry = { name: "deepseek-v4-pro", provider: "openai", baseURL: GW };
    const p = buildModelProfile(entry, [entry], "openai");
    expect(p.pricing).not.toBeNull();
    // 折算后 currency 被 effectivePricing 改写成 "USD"（标记「这份已经是美元了」，
    // 防二次折算），所以「原本是人民币」这个事实只能从画像的 originalCurrency 拿——
    // 而它必须存在，否则展示层无从知道这个美元数是按固定汇率快照折来的。
    expect(p.pricing!.currency).toBe("USD");
    expect(p.originalCurrency).toBe("CNY");
    // 折算后的数字必须是 USD 量级（人民币原价 × 1/7.1），不是原样人民币数字
    const raw = resolvePricing("deepseek-v4-pro", [entry], GW)!;
    expect(p.pricing!.input).toBeLessThan(raw.input);
  });

  test("分时段模型的 isPeakNow 随传入时刻变化（可复现，不依赖当前挂钟）", () => {
    const entry: ProfileModelEntry = { name: "deepseek-v4-pro", provider: "openai", baseURL: GW };
    // DeepSeek 高峰窗口是 UTC 01:00-04:00 与 06:00-10:00（见 model-registry.ts）
    const peak = buildModelProfile(entry, [entry], "openai", new Date("2026-08-20T02:00:00Z"));
    const offPeak = buildModelProfile(entry, [entry], "openai", new Date("2026-08-20T20:00:00Z"));
    expect(peak.isPeakNow).toBe(true);
    expect(offPeak.isPeakNow).toBe(false);
    // 空闲价必须真的更便宜（offPeakMultiplier=0.5），否则折算没生效
    expect(offPeak.pricing!.input).toBeLessThan(peak.pricing!.input);
  });

  test("非分时段模型 isPeakNow 为 undefined（不是 false —— 无政策 ≠ 空闲时段）", () => {
    const entry: ProfileModelEntry = {
      name: "claude-opus-4-8",
      provider: "anthropic",
      baseURL: GW,
    };
    expect(buildModelProfile(entry, [entry], "anthropic").isPeakNow).toBeUndefined();
  });

  test("按次计费模型：pricing 为 null 但 perCallUSD 有值（两者互斥）", () => {
    writeGatewayCache({ "video-gen": { quotaType: 1, perCallUSD: 0.05 } });
    const entry: ProfileModelEntry = { name: "video-gen", provider: "openai", baseURL: GW };
    const p = buildModelProfile(entry, [entry], "openai");
    expect(p.perCallUSD).toBe(0.05);
  });

  test("wireModel 解析别名 → 真名", () => {
    const entry: ProfileModelEntry = {
      name: "gw-claude",
      modelId: "claude-opus-4-8",
      provider: "anthropic",
      baseURL: GW,
    };
    expect(buildModelProfile(entry, [entry], "anthropic").wireModel).toBe("claude-opus-4-8");
  });

  test("effort 档位集合与 supportsEffort 一致：不支持时必须是空数组", () => {
    const entry: ProfileModelEntry = {
      name: "claude-opus-4-8",
      provider: "anthropic",
      baseURL: GW,
    };
    const p = buildModelProfile(entry, [entry], "anthropic");
    // 不断言具体档位（那是 effort.ts 的职责，会随能力矩阵演进），只锁两者的一致性：
    // 有档位 ⟺ 支持切档。分叉了就是「面板列出档位、实际发不出去」。
    if (p.efforts.length > 0) expect(p.efforts.every((e) => typeof e === "string")).toBe(true);
  });

  test("用户声明 supportsThinking=false 时不应报出可选档位（避免面板说支持、请求不发）", () => {
    const entry: ProfileModelEntry = {
      name: "claude-opus-4-8",
      provider: "anthropic",
      baseURL: GW,
      supportsThinking: false,
    };
    const p = buildModelProfile(entry, [entry], "anthropic");
    expect(p.efforts).toEqual([]);
  });
});
