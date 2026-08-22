/**
 * 定价三维度（币种 / 时段 / as-of）—— 方案 §5.5 + §5.6
 *
 * 这些测试的共同目标：让 D1「单价过期」从**静默错**降级为**会报红**。
 * 价格数字仍然需要人去更新（那件事无法自动化），但"过期"这个事实变得可检测。
 */

import { test, expect, describe } from "bun:test";
import {
  effectivePricing,
  resolvePricing,
  calculateUSDCost,
  resolvePricingUSD,
  priceTierAt,
  type ModelPricing,
} from "../../src/api/cost-tracker.ts";
import { lookupRegistryExact, getRegistryEntries } from "../../src/llm/model-registry.ts";
import {
  recordPriceTier,
  getPeakRatio,
  getPriceTierCounts,
  resetBillingSink,
} from "../../src/llm/billing-sink.ts";

/** 造一个落在指定 UTC 小时的时刻（日期任取，只有小时参与判定） */
function atUTCHour(hour: number): Date {
  return new Date(Date.UTC(2026, 7, 21, hour, 30, 0));
}

describe("effectivePricing：时段折扣", () => {
  const p: ModelPricing = {
    input: 1.32,
    output: 3.96,
    cacheRead: 0.044,
    peakWindows: [
      { startHour: 1, endHour: 4 },
      { startHour: 6, endHour: 10 },
    ],
    offPeakMultiplier: 0.5,
  };

  test("高峰时段取原价", () => {
    for (const h of [1, 2, 3, 6, 7, 9]) {
      expect(effectivePricing(p, atUTCHour(h)).input).toBeCloseTo(1.32, 6);
    }
  });

  test("空闲时段整体打折（三段价一起打，不能只打其中一段）", () => {
    // 只打部分维度是很自然的写错方式，结果是账目在时段边界上莫名跳变。
    const off = effectivePricing(p, atUTCHour(15));
    expect(off.input).toBeCloseTo(0.66, 6);
    expect(off.output).toBeCloseTo(1.98, 6);
    expect(off.cacheRead).toBeCloseTo(0.022, 6);
  });

  test("窗口是半开区间 [start, end)：端点归属明确", () => {
    expect(effectivePricing(p, atUTCHour(4)).input).toBeCloseTo(0.66, 6); // 4 已出窗
    expect(effectivePricing(p, atUTCHour(10)).input).toBeCloseTo(0.66, 6); // 10 已出窗
    expect(effectivePricing(p, atUTCHour(1)).input).toBeCloseTo(1.32, 6); // 1 在窗内
  });

  test("支持跨零点窗口（22-02）—— 不支持的话下个补时段的人会静默算错", () => {
    const wrap: ModelPricing = {
      input: 10,
      output: 20,
      peakWindows: [{ startHour: 22, endHour: 2 }],
      offPeakMultiplier: 0.5,
    };
    expect(effectivePricing(wrap, atUTCHour(23)).input).toBe(10); // 窗内
    expect(effectivePricing(wrap, atUTCHour(1)).input).toBe(10); // 跨零点后仍窗内
    expect(effectivePricing(wrap, atUTCHour(12)).input).toBe(5); // 窗外
  });

  test("无 peakWindows 时行为与改造前逐字节一致（向后兼容）", () => {
    const flat: ModelPricing = { input: 1, output: 2, cacheRead: 0.1 };
    expect(effectivePricing(flat, atUTCHour(15))).toBe(flat); // 同一个对象，未复制
  });

  test("offPeakMultiplier 缺省为 1（不打折）—— 刻意不猜 0.5", () => {
    // 猜低会系统性低估成本，而低估正是本次事故的形态。
    const noMul: ModelPricing = {
      input: 10,
      output: 20,
      peakWindows: [{ startHour: 1, endHour: 4 }],
    };
    expect(effectivePricing(noMul, atUTCHour(15)).input).toBe(10);
  });
});

describe("effectivePricing：币种换算", () => {
  test("CNY 按 fxToUSD 折算", () => {
    const cny: ModelPricing = { input: 9, output: 27, currency: "CNY", fxToUSD: 1 / 7.1 };
    const usd = effectivePricing(cny);
    expect(usd.input).toBeCloseTo(9 / 7.1, 6);
    expect(usd.currency).toBe("USD");
  });

  test("缺 fxToUSD 时**不猜汇率**（保持原数，把'我不知道'留在数据里）", () => {
    const cny: ModelPricing = { input: 9, output: 27, currency: "CNY" };
    expect(effectivePricing(cny).input).toBe(9);
  });

  test("折算后清掉 currency/peakWindows，防止二次应用（计价最常见的静默错算）", () => {
    const p: ModelPricing = {
      input: 10,
      output: 20,
      currency: "CNY",
      fxToUSD: 0.14,
      peakWindows: [{ startHour: 1, endHour: 4 }],
      offPeakMultiplier: 0.5,
    };
    const once = effectivePricing(p, atUTCHour(15));
    const twice = effectivePricing(once, atUTCHour(15));
    expect(twice.input).toBeCloseTo(once.input, 9); // 再折一次不变
  });
});

describe("DeepSeek 新价（D1 数据修复）", () => {
  test("deepseek-v4-pro 已是 2026-08-17 起的峰谷新价，不是旧的 ¥3/¥6", () => {
    // 注册表存**人民币高峰价**（厂商计价币种），见 model-registry.ts 的 DEEPSEEK_CNY_TO_USD。
    const p = lookupRegistryExact("deepseek-v4-pro")?.pricing;
    expect(p).toBeDefined();
    expect(p!.currency).toBe("CNY");
    expect(p!.input).toBeCloseTo(9, 6);
    expect(p!.output).toBeCloseTo(27, 6);
    // 命中价涨幅最大（¥0.025 → ¥0.3，12x）—— 这条最容易被漏，
    // 因为"命中几乎免费"曾经是对的，而本仓命中率目标 >70%，命中量占输入大头。
    expect(p!.cacheRead).toBeCloseTo(0.3, 6);
  });

  test("四个 DeepSeek 键（含大小写变体与弃用别名）单价互相一致", () => {
    // 注册表按精确名分开登记，只改一条的后果是：用户按哪种写法配模型名，
    // 决定了他拿到新价还是旧价。
    const pro = ["deepseek-v4-pro", "DeepSeek-V4-Pro"].map((k) => lookupRegistryExact(k)!.pricing!);
    expect(pro[0]!.input).toBe(pro[1]!.input);
    expect(pro[0]!.output).toBe(pro[1]!.output);
    expect(pro[0]!.cacheRead).toBe(pro[1]!.cacheRead);

    const flash = [
      "deepseek-v4-flash",
      "DeepSeek-V4-Flash",
      "deepseek-chat",
      "deepseek-reasoner",
    ].map((k) => lookupRegistryExact(k)!.pricing!);
    for (const f of flash) {
      expect(f.input).toBeCloseTo(3, 6);
      expect(f.output).toBeCloseTo(9, 6);
      expect(f.cacheRead).toBeCloseTo(0.1, 6);
    }
  });

  test("分时段字段齐全，且空闲价恰为高峰价一半", () => {
    const p = lookupRegistryExact("deepseek-v4-pro")!.pricing!;
    expect(p.peakWindows?.length).toBe(2);
    expect(p.offPeakMultiplier).toBe(0.5);
    // 空闲 + 折美元：¥9 × 0.5 × (1/7.1)
    expect(effectivePricing(p, atUTCHour(15)).input).toBeCloseTo((9 * 0.5) / 7.1, 6);
    // 高峰 + 折美元：¥9 × (1/7.1)
    expect(effectivePricing(p, atUTCHour(2)).input).toBeCloseTo(9 / 7.1, 6);
  });
});

describe("as-of 过期可检测（§5.6，只提示不硬拦的那条门禁的数据基础）", () => {
  test("DeepSeek 各条都带 asOf 与 source", () => {
    for (const k of [
      "deepseek-v4-pro",
      "DeepSeek-V4-Pro",
      "deepseek-v4-flash",
      "DeepSeek-V4-Flash",
      "deepseek-chat",
      "deepseek-reasoner",
    ]) {
      const p = lookupRegistryExact(k)!.pricing!;
      expect(p.asOf, `${k} 缺 asOf`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.source, `${k} 缺 source`).toBeTruthy();
    }
  });

  test("asOf 是可解析的日期，且不在未来（防手滑写成 2027）", () => {
    const p = lookupRegistryExact("deepseek-v4-pro")!.pricing!;
    const d = new Date(p.asOf!);
    expect(Number.isNaN(d.getTime())).toBe(false);
    // 用一个固定的下界而不是 Date.now()：拿"现在"比会让这条测试随时间漂。
    expect(d.getTime()).toBeGreaterThanOrEqual(new Date("2026-08-16").getTime());
  });
});

describe("计价端到端：分时段真的进了成本计算", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 900_000 };

  test("同一次用量，空闲时段成本恰为高峰的一半", () => {
    // 形参顺序：(model, usage, availableModels, provider, baseURL, at)
    const peak = calculateUSDCost(
      "deepseek-v4-pro",
      usage,
      undefined,
      "openai",
      "https://api.deepseek.com",
      atUTCHour(2),
    );
    const off = calculateUSDCost(
      "deepseek-v4-pro",
      usage,
      undefined,
      "openai",
      "https://api.deepseek.com",
      atUTCHour(15),
    );
    expect(peak).toBeGreaterThan(0);
    expect(off).toBeCloseTo(peak / 2, 8);
  });

  test("官方端点仍走注册表（不被空 key 网关桶劫持）", () => {
    const p = resolvePricing("deepseek-v4-pro", undefined, "https://api.deepseek.com");
    // resolvePricing 返回**原样**存储值（人民币），折算是 effectivePricing 的职责。
    expect(p?.input).toBeCloseTo(9, 6);
    expect(p?.currency).toBe("CNY");
    // resolvePricingUSD 才给可比的美元数（展示 / 跨模型比价用这个）。
    expect(
      resolvePricingUSD("deepseek-v4-pro", undefined, "https://api.deepseek.com", atUTCHour(2))!
        .input,
    ).toBeCloseTo(9 / 7.1, 6);
  });
});

describe("priceTierAt：时段判定的唯一实现（§5.5 落 price_tier 的基础）", () => {
  const tiered: ModelPricing = {
    input: 1,
    output: 2,
    peakWindows: [{ startHour: 1, endHour: 4 }],
    offPeakMultiplier: 0.5,
  };

  test("高峰 / 空闲 / 无政策三档各自可辨", () => {
    expect(priceTierAt(tiered, atUTCHour(2))).toBe("peak");
    expect(priceTierAt(tiered, atUTCHour(12))).toBe("offpeak");
    // "none" 必须与 offpeak 分开：混成一档会让"高峰占比"的分母随
    // 「本会话用了几个无分时段模型」漂移，那不是这个指标要表达的东西。
    expect(priceTierAt({ input: 1, output: 2 }, atUTCHour(12))).toBe("none");
  });

  test("与 effectivePricing 判据一致（两份实现漂移 = 账本说 offpeak 但按 peak 收钱）", () => {
    // 这条是本组最重要的一条：落盘的 tier 与实际计价的时段必须同源。
    for (let h = 0; h < 24; h++) {
      const at = atUTCHour(h);
      const tier = priceTierAt(tiered, at);
      const discounted = effectivePricing(tiered, at).input < tiered.input;
      expect(discounted).toBe(tier === "offpeak");
    }
  });

  test("注册表里真实的 DeepSeek 条目：两档都取得到", () => {
    const p = lookupRegistryExact("deepseek-v4-pro")!.pricing!;
    const tiers = new Set(Array.from({ length: 24 }, (_, h) => priceTierAt(p, atUTCHour(h))));
    expect(tiers.has("peak")).toBe(true);
    expect(tiers.has("offpeak")).toBe(true);
    expect(tiers.has("none")).toBe(false);
  });
});

describe("高峰占比采集（§5.5 落进账本的 peakRatio）", () => {
  test("分母为 0 时返回 undefined，不返回 0", () => {
    resetBillingSink();
    // 这个区分是刻意的：0 = "有分时段模型且全落空闲"（真实的好结果），
    // undefined = "本会话没有分时段模型"。混成 0 会造出一批假的"100% 空闲"会话。
    expect(getPeakRatio()).toBeUndefined();
    recordPriceTier("none");
    recordPriceTier("none");
    expect(getPeakRatio()).toBeUndefined();
    expect(getPriceTierCounts()).toEqual({ peak: 0, tiered: 0 });
  });

  test("只有分时段请求进分母，比例按 peak/tiered 算", () => {
    resetBillingSink();
    recordPriceTier("peak");
    recordPriceTier("offpeak");
    recordPriceTier("offpeak");
    recordPriceTier("none"); // 不进分母
    expect(getPriceTierCounts()).toEqual({ peak: 1, tiered: 3 });
    expect(getPeakRatio()).toBeCloseTo(1 / 3, 10);
  });

  test("全部落空闲时是 0（而不是 undefined）—— 与上面那条互为对照", () => {
    resetBillingSink();
    recordPriceTier("offpeak");
    expect(getPeakRatio()).toBe(0);
    resetBillingSink();
  });
});

describe("asOf 陈旧可检测（§5.6 只提示不硬拦的那条门禁的数据基础）", () => {
  test("带 asOf 的条目日期合法且不在未来", () => {
    const withAsOf = getRegistryEntries().filter(([, e]) => e.pricing?.asOf);
    // 分母自证：一条都没有时下面的循环恒不执行，这个测试就成了假门禁。
    expect(withAsOf.length).toBeGreaterThan(0);
    const tomorrow = Date.now() + 86_400_000;
    for (const [key, e] of withAsOf) {
      const t = Date.parse(`${e.pricing!.asOf}T00:00:00Z`);
      expect(Number.isNaN(t), `${key} 的 asOf 不是合法日期`).toBe(false);
      expect(t, `${key} 的 asOf 在未来（手滑写错年份）`).toBeLessThan(tomorrow);
    }
  });

  test("带 asOf 的条目必须同时带 source（否则无从回源核价）", () => {
    for (const [key, e] of getRegistryEntries()) {
      if (!e.pricing?.asOf) continue;
      expect(e.pricing.source, `${key} 有 asOf 却没有 source`).toBeTruthy();
    }
  });

  test("非 USD 计价必须带 fxToUSD（缺了会把人民币当美元算，低估 7 倍）", () => {
    let nonUSD = 0;
    for (const [key, e] of getRegistryEntries()) {
      const p = e.pricing;
      if (!p?.currency || p.currency === "USD") continue;
      nonUSD += 1;
      expect(typeof p.fxToUSD, `${key} 是 ${p.currency} 计价却没有 fxToUSD`).toBe("number");
      expect(p.fxToUSD!).toBeGreaterThan(0);
    }
    // 分母自证：当前 6 条 DeepSeek 是 CNY 计价。
    expect(nonUSD).toBeGreaterThan(0);
  });
});
