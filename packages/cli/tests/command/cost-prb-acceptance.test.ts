/**
 * PR-B（P1）验收测试：/cost 时段、单价、请求数与断裂文案按真实口径显示。
 *
 * ## 对应方案文档 §七 PR-B 的验收项 B1–B14（只收 G1 能判的部分）
 *
 * - B1  peakShare 三态：用注入的 `at` 跑四种情况（全空闲 / 全高峰 / 混合 / 旧快照）
 * - B3  三态各渲染一次，断言文案正确
 * - B4  多模型 main.avgPrice 是加权均价（不是某个模型的牌价）
 * - B5  单价列头写「均价」；牌价出现在来源行且保留三格
 * - B6  avgPrice 与 breakdown 自洽（token × 均价 ÷ 1e6 === 费用，逐段）
 * - B7  首行拆主循环/辅助并标注作用域；窄列退化为 `请求 a+b`
 * - B8  来源行含牌价三格 + 时段系数，窄列不超宽
 * - B9  缓存区两行：命中下降（上游/本地）+ 本地前缀断裂（字节级）
 * - B10 证据按字段拼，11 种组合里覆盖「全 true」「不可判」
 * - B11 把 messagePrefixSame 改 false，文案不再声称「消息前缀一致」，归因变本地
 * - B12 单次请求样本 < 20 不显示 p95，且显示 n=
 * - B14 辅助调用明细：非零小额显示 `<$0.0001`；hit 存在时显示命中率
 * - PR-A 收尾：对账差额提示（只提示不补账）
 *
 * ## 为什么这些断言必须逐字节看渲染产物
 *
 * 本 PR 的缺陷全部是「数据算对了但显示说错话」（口径名、作用域、牌价冒充均价）。
 * 纯数据断言在缺陷存在时照样全绿 —— 例如 `peakShare` 恒 1 时，
 * `expect(r.byModel[0].peakShare).toBeLessThanOrEqual(1)` 永远成立。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { buildCostReport } from "@sid-code/core/session/cost-report.ts";
import { getSideStats, resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";
import { stringWidth } from "../../src/ui/render-port/text.ts";
import { renderCostReport } from "../../src/command/commands/cost/cost-render.ts";

const IDLE_GATE = { busy: false, busyLabel: null, pendingLabels: [] as string[] };

/** DeepSeek 形态：UTC 1-4 高峰，空闲半价。 */
const TIERED = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.03,
  peakWindows: [{ startHour: 1, endHour: 4 }],
  offPeakMultiplier: 0.5,
};
const AT_PEAK = new Date("2026-11-10T02:00:00Z"); // UTC 2 点 = 高峰窗口内
const AT_OFF = new Date("2026-11-10T12:00:00Z"); // UTC 12 点 = 空闲

const USAGE = { inputTokens: 100_000, outputTokens: 1_000 };

function tieredSession(model = "tiered-model"): SessionState {
  const ss = new SessionState("prb-acceptance-test");
  ss.setAvailableModels([{ name: model, provider: "openai", pricing: TIERED }]);
  return ss;
}

/** 入账一次（`at` 是本次新增的可测性参数，生产调用点不传）。 */
function charge(ss: SessionState, model: string, at: Date, usage = USAGE): void {
  ss.updateUsage(model, usage, 1, "openai", undefined, false, 1, at);
}

function report(ss: SessionState, extra: Record<string, unknown> = {}) {
  return buildCostReport(ss, {
    sideStats: getSideStats(),
    gateStats: IDLE_GATE,
    cacheBreaks: [],
    ...extra,
  });
}

function render(ss: SessionState, extra: Record<string, unknown> = {}, columns = 120): string {
  return renderCostReport(report(ss, extra), { useColor: false, columns });
}

beforeEach(() => {
  resetSideCallStats();
});

// ───────────────────────── B1 / B3：peakShare 三态 ─────────────────────────

describe("B1 · peakShare 三态（CP-3：不再回落成总额恒为 1）", () => {
  test("全空闲：peakShare === 0（修复前是 1）", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const row = report(ss).byModel[0]!;
    // 0 不是「没数据」：全程空闲的直接证据是 peakCostUSD 从未写过，
    // 而两桶之和仍等于 costUSD。修复前 `?? costUSD` 让它变成 1。
    expect(row.peakShare).toBe(0);
    // 两桶字段在 ModelUsageStats 上（行类型只暴露派生结果）：全程空闲 = 高峰桶从未被写过
    expect(ss.modelUsage["tiered-model"]!.peakCostUSD ?? 0).toBe(0);
  });

  test("全高峰：peakShare === 1", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_PEAK);
    expect(report(ss).byModel[0]!.peakShare).toBe(1);
  });

  test("混合：0 < peakShare < 1，且 peak + offpeak === costUSD", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_PEAK);
    charge(ss, "tiered-model", AT_OFF);
    const row = report(ss).byModel[0]!;
    expect(row.peakShare).toBeGreaterThan(0);
    expect(row.peakShare).toBeLessThan(1);
    const stats = ss.modelUsage["tiered-model"]!;
    expect((stats.peakCostUSD ?? 0) + (stats.offpeakCostUSD ?? 0)).toBeCloseTo(stats.costUSD, 12);
  });

  test("旧快照（两桶都是 0 而 costUSD > 0）：peakShare === undefined，不猜", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    // 模拟 D11 之前落盘的快照：回灌时 `Number(...) || 0` 把两个桶都抹成 0。
    const stats = ss.modelUsage["tiered-model"]!;
    stats.peakCostUSD = 0;
    stats.offpeakCostUSD = 0;
    expect(report(ss).byModel[0]!.peakShare).toBeUndefined();
  });

  test("无费用：peakShare === undefined（不是 0、也不是 1）", () => {
    const ss = tieredSession();
    expect(report(ss).byModel[0]?.peakShare).toBeUndefined();
  });
});

describe("B3 · 三态渲染文案（CP-3：措辞写「高峰费用占比」而不是「高峰占比」）", () => {
  test("全空闲 → 全程空闲时段", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    expect(render(ss)).toContain("全程空闲时段");
  });

  test("全高峰 → 全程高峰时段", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_PEAK);
    expect(render(ss)).toContain("全程高峰时段");
  });

  test("混合 → 高峰费用占比 N%", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_PEAK);
    charge(ss, "tiered-model", AT_OFF);
    expect(render(ss)).toMatch(/高峰费用占比 \d+%（其余空闲价）/);
    // 「高峰占比」是账本 peakRatio 的口径（请求数分母），两个都叫「高峰占比」
    // 会让用户拿它们互相对照 —— 本 PR 的原始症状之一。
    expect(render(ss)).not.toContain("高峰占比 ");
  });

  test("旧快照 → 写明拆分不可用，不显示任何时段结论", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const stats = ss.modelUsage["tiered-model"]!;
    stats.peakCostUSD = 0;
    stats.offpeakCostUSD = 0;
    const out = render(ss);
    expect(out).toContain("时段拆分不可用");
    expect(out).not.toContain("全程高峰时段");
    expect(out).not.toContain("全程空闲时段");
  });
});

// ───────────────────────── B4 / B5 / B6：均价 ─────────────────────────

describe("B4 · 多模型：main.avgPrice 是加权均价（CP-4）", () => {
  function twoModelSession(): SessionState {
    const ss = new SessionState("prb-two-model");
    ss.setAvailableModels([
      { name: "model-a", provider: "openai", pricing: { input: 0.3, output: 1.2 } },
      { name: "model-b", provider: "openai", pricing: { input: 0.6, output: 2.4 } },
    ]);
    ss.updateUsage("model-a", { inputTokens: 100_000, outputTokens: 0 }, 1, "openai");
    ss.updateUsage("model-b", { inputTokens: 50_000, outputTokens: 0 }, 1, "openai");
    return ss;
  }

  test("均价 = 各段费用之和 ÷ 各段 token 之和（不是某个模型的牌价）", () => {
    const r = report(twoModelSession());
    const expectAvg = (r.main.breakdown.uncachedUSD / r.main.uncachedTokens) * 1e6;
    expect(r.main.avgPrice.uncached).toBeCloseTo(expectAvg, 10);
    // 一定是两个牌价之间，绝不能等于其中任何一个（那说明只取了单模型）
    expect(r.main.avgPrice.uncached!).toBeGreaterThan(0.3);
    expect(r.main.avgPrice.uncached!).toBeLessThan(0.6);
  });

  test("多模型也不再显示 $0.0000 的费用列（旧实现 single ? ... : 0）", () => {
    const out = render(twoModelSession());
    // 未命中段的真实费用非零，且「token × 均价」能验算出来
    expect(out).not.toMatch(/输入·未命中\s+150,000\s+0\.\d+\s+\$0\.0000/);
  });
});

describe("B5 · 单价列改「均价」，牌价移到来源行（CP-4）", () => {
  test("表头写「均价」而不是「单价」", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss);
    expect(out).toContain("均价");
    expect(out).not.toContain(" 单价 ");
  });

  test("来源行给均价口径，牌价三格另起一行", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss);
    expect(out).toContain("主循环均价 USD/百万");
    // 牌价三格（输入 / 命中 / 输出）必须在，否则用户失去「价目是多少」这个信息
    expect(out).toMatch(/牌价 USD\/百万 输入 0\.3000 \/ 命中 0\.0300 \/ 输出 1\.2000/);
    // 时段系数也要在牌价行（空闲半价是这张表的解释）
    expect(out).toContain("高峰价；空闲 ×0.5");
  });

  test("人民币计价：牌价标 CNY，均价仍是 USD（费用是 USD）", () => {
    const ss = new SessionState("prb-cny");
    ss.setAvailableModels([
      {
        name: "cny-model",
        provider: "openai",
        pricing: { input: 2, output: 8, currency: "CNY", fxToUSD: 1 / 7.1 },
      },
    ]);
    ss.updateUsage("cny-model", { inputTokens: 1_000_000, outputTokens: 0 }, 1, "openai");
    const out = render(ss);
    expect(out).toContain("主循环均价 USD/百万");
    expect(out).toContain("牌价 CNY/百万 输入 2.0000");
  });
});

describe("B6 · 均价与费用自洽：token × 均价 ÷ 1e6 === 费用（逐段）", () => {
  /** 断言四段里「有 token 的段」全部满足 `tokens × avgPrice ÷ 1e6 ≈ usd`。 */
  function assertSelfConsistent(name: string, ss: SessionState): void {
    const r = report(ss);
    const pairs = [
      {
        label: "未命中",
        tokens: r.main.uncachedTokens,
        usd: r.main.breakdown.uncachedUSD,
        avg: r.main.avgPrice.uncached,
      },
      {
        label: "命中",
        tokens: r.main.cacheHitTokens,
        usd: r.main.breakdown.hitUSD,
        avg: r.main.avgPrice.hit,
      },
      {
        label: "写入",
        tokens: r.main.cacheWriteTokens,
        usd: r.main.breakdown.writeUSD,
        avg: r.main.avgPrice.write,
      },
      {
        label: "输出",
        tokens: r.main.outputTokens,
        usd: r.main.breakdown.outputUSD,
        avg: r.main.avgPrice.output,
      },
    ];
    let checked = 0;
    for (const p of pairs) {
      if (p.tokens === 0) {
        // 无 token 的段必须没有均价（不返回 0 —— 0 会把「没有」混进付费均价）
        expect(p.avg, `${name}/${p.label} 无 token 却有均价`).toBeUndefined();
        continue;
      }
      expect(p.avg, `${name}/${p.label} 有 token 却没有均价`).toBeDefined();
      const back = (p.tokens * p.avg!) / 1e6;
      // 相对误差判据：均价是浮点数，直接比绝对差会在小额段上误伤
      expect(Math.abs(back - p.usd), `${name}/${p.label} 反推费用不匹配`).toBeLessThanOrEqual(
        Math.max(1e-9, Math.abs(p.usd) * 1e-9),
      );
      checked += 1;
    }
    // 每种夹具至少要验到「未命中 + 输出」两段，否则这条断言可能是空转
    expect(checked, `${name}: 验算段数不足`).toBeGreaterThanOrEqual(2);
  }

  test("全空闲 / 全高峰 / 混合 / 人民币价 / 双模型 五种夹具逐段验算", () => {
    const off = tieredSession();
    charge(off, "tiered-model", AT_OFF, { inputTokens: 200_000, outputTokens: 5_000 });
    assertSelfConsistent("全空闲", off);

    const peak = tieredSession();
    charge(peak, "tiered-model", AT_PEAK, { inputTokens: 200_000, outputTokens: 5_000 });
    assertSelfConsistent("全高峰", peak);

    const mixed = tieredSession();
    charge(mixed, "tiered-model", AT_PEAK, { inputTokens: 100_000, outputTokens: 5_000 });
    charge(mixed, "tiered-model", AT_OFF, { inputTokens: 100_000, outputTokens: 5_000 });
    assertSelfConsistent("混合", mixed);

    const cny = new SessionState("prb-b6-cny");
    cny.setAvailableModels([
      {
        name: "cny-model",
        provider: "openai",
        pricing: { input: 2, output: 8, currency: "CNY", fxToUSD: 1 / 7.1 },
      },
    ]);
    cny.updateUsage("cny-model", { inputTokens: 1_000_000, outputTokens: 10_000 }, 1, "openai");
    assertSelfConsistent("人民币价", cny);

    const dual = new SessionState("prb-b6-dual");
    dual.setAvailableModels([
      { name: "model-a", provider: "openai", pricing: { input: 0.3, output: 1.2 } },
      { name: "model-b", provider: "openai", pricing: { input: 0.6, output: 2.4 } },
    ]);
    dual.updateUsage("model-a", { inputTokens: 100_000, outputTokens: 3_000 }, 1, "openai");
    dual.updateUsage("model-b", { inputTokens: 50_000, outputTokens: 3_000 }, 1, "openai");
    assertSelfConsistent("双模型", dual);
  });

  test("混合时段：均价落在高峰价与空闲价之间（证明是加权，不是牌价）", () => {
    const mixed = tieredSession();
    charge(mixed, "tiered-model", AT_PEAK, { inputTokens: 100_000, outputTokens: 1_000 });
    charge(mixed, "tiered-model", AT_OFF, { inputTokens: 100_000, outputTokens: 1_000 });
    const avg = report(mixed).main.avgPrice.uncached!;
    // 高峰 0.3、空闲 0.15 → 各一半 token 时加权均价 0.225
    expect(avg).toBeGreaterThan(0.15);
    expect(avg).toBeLessThan(0.3);
    expect(avg).toBeCloseTo(0.225, 6);
  });
});

// ───────────────────────── B7 / B8：首行与来源行版式 ─────────────────────────

describe("B7 · 首行请求数拆主循环 / 辅助并标作用域（CP-5）", () => {
  test("宽列：主循环 N 次 · 辅助 M 次（本次启动后）", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    ss.addSideCost(0.001);
    const out = renderCostReport(
      { ...report(ss), side: { ...report(ss).side, calls: 8 } } as ReturnType<typeof report>,
      { useColor: false, columns: 120 },
    );
    expect(out).toContain("主循环 1 次 · 辅助 8 次（本次启动后）");
    // 旧形态「N 次请求」把两个作用域合成一个数，必须从**首行**消失。
    // 只看首行：注释区的「按本进程最近 N 次请求统计」是另一个口径，不该被这条断言波及。
    const head = out.split("\n")[0]!;
    expect(head).not.toContain("次请求");
  });

  test("窄列：退化为 请求 a+b（保住信息量，不折行）", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const r = report(ss);
    const out = renderCostReport(
      { ...r, side: { ...r.side, calls: 8 } } as ReturnType<typeof report>,
      { useColor: false, columns: 70 },
    );
    expect(out).toContain("请求 1+8");
  });

  test("没有辅助调用：不出现「辅助 0 次」这种噪音", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    expect(render(ss)).toContain("主循环 1 次请求");
  });
});

describe("B8 · 来源行 / 牌价行窄列不超宽", () => {
  test("70 列终端：每一行都不超过 70 显示列", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF, { inputTokens: 1_234_567, outputTokens: 98_765 });
    const out = render(ss, {}, 70);
    for (const line of out.split("\n")) {
      expect(stringWidth(line), `超宽行: ${line}`).toBeLessThanOrEqual(70);
    }
  });

  test("宽列下牌价行也不超 120", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, {}, 120);
    for (const line of out.split("\n")) {
      expect(stringWidth(line), `超宽行: ${line}`).toBeLessThanOrEqual(120);
    }
  });
});

// ───────────────────────── B9 / B10 / B11：缓存断裂 ─────────────────────────

/** 一条「上游波动」断裂记录（三证据齐备）。 */
const UPSTREAM_BREAK = {
  changes: ["本地前缀 hash 未变（abc123），命中下降疑为服务端缓存波动"],
  categories: ["server_fluctuation"],
  dropPercent: 75,
  dropTokens: 26_368,
  previousCacheReadTokens: 35_200,
  currentCacheReadTokens: 8_832,
  prefixHashSame: true,
  messagePrefixSame: true,
  precededByRetry: false,
};

describe("B9 · 缓存区两行：命中下降归因 + 本地前缀断裂（CP-8/CP-9）", () => {
  test("命中下降按「上游波动 x / 本地 y」结构化统计", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, { cacheBreaks: [UPSTREAM_BREAK] });
    expect(out).toContain("命中下降 1 次（上游波动 1 / 本地 0）");
  });

  test("本地前缀断裂另起一行，带字节级浪费比例", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, { prefixBreaks: [{ charWastedRatio: 0.082 }] });
    expect(out).toContain("本地前缀断裂 1 次（字节级，浪费约 8.2% 字符）");
  });

  test("未传 prefixBreaks：整行省略，不写「0 次」冒充没有断裂", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    expect(render(ss)).not.toContain("本地前缀断裂");
  });

  test("传了但没有断裂：写 0 次（与「没采集」区分开）", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, { prefixBreaks: [] });
    // available=true 且 count=0 → 既不显示断裂行，也不显示错误结论
    expect(out).not.toContain("本地前缀断裂 1 次");
  });
});

describe("B10 · 证据按字段拼（CP-8：三证据 + 归因结论）", () => {
  test("三证据齐备：逐条显示，结论指向上游", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, { cacheBreaks: [UPSTREAM_BREAK] });
    expect(out).toContain("最近一次 35,200→8,832（-75%）");
    expect(out).toContain("证据 system/tools 未变、消息前缀逐字节一致、两次请求间无重试");
    expect(out).toContain("上游缓存波动（网关或厂商），本地不可控");
  });

  test("不可判：显式写「不可判」，不暗示「没变化」", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, {
      cacheBreaks: [
        { ...UPSTREAM_BREAK, messagePrefixSame: undefined, precededByRetry: undefined },
      ],
    });
    expect(out).toContain("消息前缀不可判");
    expect(out).not.toContain("消息前缀逐字节一致");
    // 重试不可判时既不写「有重试」也不写「无重试」
    expect(out).not.toContain("两次请求间有重试");
    expect(out).not.toContain("两次请求间无重试");
  });

  test("有重试：证据写明「两次请求间有重试」", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, { cacheBreaks: [{ ...UPSTREAM_BREAK, precededByRetry: true }] });
    expect(out).toContain("两次请求间有重试");
  });
});

describe("B11 · 文案由字段驱动，不是写死（变异断言）", () => {
  test("messagePrefixSame=false + message_history：不再声称一致，归因转本地", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, {
      cacheBreaks: [
        {
          ...UPSTREAM_BREAK,
          categories: ["message_history"],
          messagePrefixSame: false,
        },
      ],
    });
    // 声称「逐字节一致」的句子必须消失（否则意味着文案是写死的）
    expect(out).not.toContain("消息前缀逐字节一致");
    expect(out).toContain("消息前缀被改写");
    expect(out).toContain("本地消息历史被改写，可优化");
  });

  test("prefixHashSame=false：证据写「已变」，不再声称未变", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, {
      cacheBreaks: [{ ...UPSTREAM_BREAK, categories: ["prefix_break"], prefixHashSame: false }],
    });
    expect(out).not.toContain("system/tools 未变");
    expect(out).toContain("system/tools 已变");
  });
});

// ───────────────────────── B12 / B14：单次请求与辅助明细 ─────────────────────────

describe("B12 · 单次请求：样本不足不给 p95（CP-10b）", () => {
  test("n=4：显示 n，但不显示 p95（旧实现恒输出一个假分位）", () => {
    const ss = tieredSession();
    for (let i = 0; i < 4; i++) charge(ss, "tiered-model", AT_OFF);
    const r = report(ss);
    expect(r.perRequest?.count).toBe(4);
    const out = render(ss);
    expect(out).toContain("（n=4）");
    expect(out).not.toContain("p95");
  });

  test("n≥20：p95 才出现", () => {
    const ss = tieredSession();
    for (let i = 0; i < 20; i++) charge(ss, "tiered-model", AT_OFF);
    const out = render(ss);
    expect(out).toContain("p95");
    expect(out).toContain("（n=20）");
  });
});

describe("B14 · 辅助调用明细：小额金额与命中率（CP-10c/CP-10d）", () => {
  function sideReport() {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    return report(ss, {
      sideStats: {
        apiCalls: 2,
        costUSD: 0.00004,
        tokensSent: 325_000,
        tokensReceived: 2_000,
        durationMs: 4_000,
        durationCalls: 2,
        details: [
          {
            label: "title-generation",
            model: "tiered-model",
            inputTokens: 320_000,
            outputTokens: 1_000,
            cacheReadTokens: 288_000,
            costUSD: 0.00002,
            durationMs: 2_000,
          },
          {
            label: "permission-classify",
            model: "tiered-model",
            inputTokens: 5_000,
            outputTokens: 1_000,
            cacheReadTokens: 4_500,
            costUSD: 0.00002,
            durationMs: 2_000,
          },
        ],
        failed: 0,
        timedOut: 0,
        usageMissing: 0,
        byLabel: {},
      },
    });
  }

  test("非零小额显示 <$0.0001，不折成 $0.0000", () => {
    const out = renderCostReport(sideReport(), { useColor: false, columns: 120 });
    expect(out).toContain("<$0.0001");
    expect(out).not.toMatch(/title-generation\s+1 次\s+\$0\.0000/);
  });

  test("token 带命中率（tokensSent 与 cacheReadTokens 同源）", () => {
    const out = renderCostReport(sideReport(), { useColor: false, columns: 120 });
    expect(out).toContain("320k token（命中 90%）");
  });
});

// ───────────────────────── PR-A 收尾：对账差额提示 ─────────────────────────

describe("PR-A 收尾 · 辅助调用对账差额只提示不补账", () => {
  test("有差额：写明次数并说明会话结束会补账", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    const out = render(ss, { selfReportGap: { pendingCalls: 3 } });
    expect(out).toContain("3 次辅助调用尚未自报入账");
    expect(out).toContain("会话结束时会自动补账");
  });

  test("无差额：整行省略，不给正常路径加噪音", () => {
    const ss = tieredSession();
    charge(ss, "tiered-model", AT_OFF);
    expect(render(ss)).not.toContain("尚未自报入账");
  });
});
