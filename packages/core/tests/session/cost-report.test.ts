/**
 * PR-B（/cost 重做为分区账单）的 core 侧回归测试。
 *
 * ## 防什么
 *
 * - T-B1：四段费用之和必须等于总额——**同一行代码**算出来的（updateUsage 直接用
 *   calculateCostBreakdown 的四段入账），不是两处各算后碰巧相等（D12）。
 * - T-B2：token 三段互斥（uncached + hit + write = promptTotal），openai 族的
 *   「输入含命中」不再和命中数混着展示（D5 的数据基础）。
 * - T-B3：**用取证会话的真实数字端到端对账**（方案文档 2.3 节，人工核过的轨迹）：
 *   31 条主循环 + 6 条辅助，buildCostReport 的每个数都必须对上。
 * - T-B10：逐次明细环形缓冲**有界**（D13：无界数组是内存泄漏）。
 * - T-B11：两套计价函数同值（D20 前半：calculateUSDCost 与 calculateCost 共享
 *   breakdown 后，本地 provider 也必须同为 0）。
 * - peak/offpeak 拆分（D11）：peak + offpeak === costUSD，时段判据与计价同源。
 * - hydrate 回灌：新增字段跨 resume 不丢（漏了 restore 会静默归零且测试全绿）。
 *
 * ## 真实数据的来源与截断口径
 *
 * 取证会话 `20261110-142303-21c3a481` 的 events.jsonl 截断到 `2026-11-10T06:28:50Z`
 * （该会话有第二段任务，不截断会多算 20 条）。期望值 = 方案文档 2.3 节逐笔重算的
 * 人工核对值，不是从实现反推的。单价注入取证会话当时的网关 expr 价
 * （setAvailableModels 用户手写价优先级最高，不依赖本机网关缓存，测试确定性）。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "../../src/session/state.ts";
import { buildCostReport } from "../../src/session/cost-report.ts";
import { calculateUSDCost, calculateCostBreakdown } from "../../src/api/cost-tracker.ts";
import {
  recordSideCall,
  resetSideCallStats,
  getSideStats,
} from "../../src/trace/side-call-sink.ts";
// 方案 B4 的一致性断言要同时读两侧：面板的 `peakShare`（按**费用**算）与账本的
// `getPeakRatio()`（按**请求次数**算）。两者数据源不同，所以只能锁「同向」不能锁相等。
import { recordPriceTier, getPeakRatio, resetBillingSink } from "../../src/llm/billing-sink.ts";
import type { Usage } from "../../src/llm/types.ts";

/** 取证会话当时的网关 expr 价（USD/1M，方案 2.3 节人工核对值）。 */
const GW = {
  input: 0.27397,
  output: 1.09589,
  cacheRead: 0.00548,
  cacheWrite: 0,
};
const GW_BASE_URL = "https://uniapi.ruijie.com.cn/v1";
const MODEL = "origin-deepseek-v4-1-flash";

/** 注入网关价的 SessionState（用户手写价优先级最高，测试不依赖网关缓存文件）。 */
function gwSession(): SessionState {
  const ss = new SessionState("cost-report-test");
  ss.setAvailableModels([
    { name: MODEL, provider: "openai", baseURL: GW_BASE_URL, pricing: { ...GW } },
  ]);
  return ss;
}

// ── 取证会话真实数据（截断到 06:28:50Z，31 主循环 + 6 辅助）──
// prettier-ignore
const MAIN_USAGE: Array<{ in: number; out: number; read: number; write: number }> = [
  { in: 43880, out: 122, read: 7680, write: 0 },
  { in: 55553, out: 887, read: 43264, write: 0 },
  { in: 56743, out: 200, read: 7680, write: 0 },
  { in: 57709, out: 467, read: 56064, write: 0 },
  { in: 58474, out: 130, read: 54912, write: 0 },
  { in: 59299, out: 143, read: 57856, write: 0 },
  { in: 61683, out: 259, read: 57088, write: 0 },
  { in: 62844, out: 205, read: 58624, write: 0 },
  { in: 63122, out: 527, read: 61952, write: 0 },
  { in: 65166, out: 209, read: 62464, write: 0 },
  { in: 68683, out: 313, read: 64512, write: 0 },
  { in: 72302, out: 566, read: 61056, write: 0 },
  { in: 76620, out: 835, read: 71680, write: 0 },
  { in: 77552, out: 397, read: 68096, write: 0 },
  { in: 78640, out: 494, read: 75648, write: 0 },
  { in: 80347, out: 1200, read: 76928, write: 0 },
  { in: 81466, out: 393, read: 79360, write: 0 },
  { in: 82351, out: 393, read: 80896, write: 0 },
  { in: 83711, out: 1034, read: 81792, write: 0 },
  { in: 85482, out: 570, read: 83072, write: 0 },
  { in: 86374, out: 311, read: 84864, write: 0 },
  { in: 87329, out: 1327, read: 78080, write: 0 },
  { in: 88795, out: 266, read: 85760, write: 0 },
  { in: 92695, out: 897, read: 86656, write: 0 },
  { in: 93971, out: 340, read: 88192, write: 0 },
  { in: 94623, out: 230, read: 92032, write: 0 },
  { in: 94935, out: 314, read: 93312, write: 0 },
  { in: 95450, out: 232, read: 93952, write: 0 },
  { in: 95772, out: 1727, read: 94336, write: 0 },
  { in: 97948, out: 856, read: 94848, write: 0 },
  { in: 99126, out: 1596, read: 97280, write: 0 },
];
// prettier-ignore
const SIDE_USAGE: Array<{ label: string; in: number; out: number; read: number; write: number }> = [
  { label: "title_generation", in: 112, out: 6, read: 0, write: 0 },
  { label: "fork:session-memory-update", in: 100324, out: 78, read: 7680, write: 0 },
  { label: "fork:memory-extract", in: 121001, out: 816, read: 7680, write: 0 },
  { label: "fork:memory-extract", in: 121908, out: 416, read: 120320, write: 0 },
  { label: "fork:session-memory-update", in: 100690, out: 2628, read: 99712, write: 0 },
  { label: "fork:session-memory-update", in: 103384, out: 208, read: 100096, write: 0 },
];

const IDLE_GATE = { busy: false, busyLabel: null, pendingLabels: [] as string[] };

/** 按取证会话的形态重放：主循环走 updateUsage，辅助走 recordSideCall + addSideCost。 */
function replayForensicSession(): SessionState {
  resetSideCallStats();
  const ss = gwSession();
  for (const r of MAIN_USAGE) {
    ss.updateUsage(
      MODEL,
      {
        inputTokens: r.in,
        outputTokens: r.out,
        cacheReadInputTokens: r.read,
        cacheCreationInputTokens: r.write,
      },
      0,
      "openai",
      GW_BASE_URL,
    );
  }
  for (const r of SIDE_USAGE) {
    const usage: Usage = {
      inputTokens: r.in,
      outputTokens: r.out,
      cacheReadInputTokens: r.read,
      cacheCreationInputTokens: r.write,
    };
    const cost = ss.calculateCost(MODEL, usage, "openai", GW_BASE_URL);
    recordSideCall({
      label: r.label,
      model: MODEL,
      inputTokens: r.in,
      outputTokens: r.out,
      cacheReadTokens: r.read,
      cacheCreationTokens: r.write,
      costUSD: cost,
    });
    // 生产路径由 side-call-sink 的 costObserver 回调 addSideCost；测试没有 observer，手动补。
    ss.addSideCost(cost);
  }
  return ss;
}

describe("T-B1：四段费用之和 === 总额（同一行代码保证，D12）", () => {
  test("openai 族（含命中）", () => {
    const ss = gwSession();
    const usage = { inputTokens: 121_908, outputTokens: 416, cacheReadInputTokens: 120_320 };
    const b = calculateCostBreakdown(MODEL, usage, ss.getAvailableModels(), "openai", GW_BASE_URL);
    const total = ss.calculateCost(MODEL, usage, "openai", GW_BASE_URL);
    expect(b.uncachedInputUSD + b.cacheHitUSD + b.cacheWriteUSD + b.outputUSD).toBeCloseTo(
      total,
      12,
    );
  });

  test("anthropic 族（input 是未命中余量 + 有写入）", () => {
    const ss = new SessionState("tb1-anthropic");
    const usage = {
      inputTokens: 500,
      outputTokens: 100,
      cacheReadInputTokens: 8_000,
      cacheCreationInputTokens: 1_500,
    };
    const b = calculateCostBreakdown("claude-test", usage, [], "anthropic", undefined);
    const total = ss.calculateCost("claude-test", usage, "anthropic", undefined);
    expect(b.uncachedInputUSD + b.cacheHitUSD + b.cacheWriteUSD + b.outputUSD).toBeCloseTo(
      total,
      12,
    );
    expect(b.cacheWriteUSD).toBeGreaterThan(0); // 写入项有值——变异「漏掉写入项」时这条红
  });

  test("兜底价（未知模型，source=fallback）", () => {
    const ss = new SessionState("tb1-fallback");
    const usage = { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 6_500 };
    const b = calculateCostBreakdown("totally-unknown-model-zzz", usage, [], "openai", undefined);
    const total = ss.calculateCost("totally-unknown-model-zzz", usage, "openai", undefined);
    expect(b.source).toBe("fallback");
    expect(b.uncachedInputUSD + b.cacheHitUSD + b.cacheWriteUSD + b.outputUSD).toBeCloseTo(
      total,
      12,
    );
    // 入账侧也记下了 source=fallback（/cost 亮黄警告的判据）
    ss.updateUsage("totally-unknown-model-zzz", usage, 0, "openai", undefined);
    expect(ss.modelUsage["totally-unknown-model-zzz"]?.pricingSource).toBe("fallback");
  });

  test("本地 provider：两套计价函数都恒 0（D20 差异 1 的回归）", () => {
    const usage = { inputTokens: 50_000, outputTokens: 1_000 };
    // calculateUSDCost（轨迹重算路径）：修复前不判本地 provider，按兜底价算出非零费用
    expect(calculateUSDCost("llama3", usage, [], "ollama", undefined)).toBe(0);
    const ss = new SessionState("tb1-local");
    expect(ss.calculateCost("llama3", usage, "ollama", undefined)).toBe(0);
    ss.updateUsage("llama3", usage, 0, "ollama", undefined);
    expect(ss.modelUsage["llama3"]?.pricingSource).toBe("local");
  });

  test("跨高峰/空闲：peak 时刻与 offpeak 时刻各自成立", () => {
    const peakPricing = {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.006,
      peakWindows: [{ startHour: 1, endHour: 4 }],
      offPeakMultiplier: 0.5,
    };
    const ss = new SessionState("tb1-tiered");
    ss.setAvailableModels([{ name: "tiered-model", provider: "openai", pricing: peakPricing }]);
    const usage = { inputTokens: 100_000, outputTokens: 1_000 };
    const atPeak = new Date("2026-11-10T02:00:00Z"); // UTC 1-4 = 高峰
    const atOff = new Date("2026-11-10T12:00:00Z"); // 其余 = 空闲半价
    for (const at of [atPeak, atOff]) {
      const b = calculateCostBreakdown(
        "tiered-model",
        usage,
        ss.getAvailableModels(),
        "openai",
        undefined,
        at,
      );
      const total = ss.calculateCost("tiered-model", usage, "openai", undefined, at);
      expect(b.uncachedInputUSD + b.cacheHitUSD + b.cacheWriteUSD + b.outputUSD).toBeCloseTo(
        total,
        12,
      );
    }
    // 高峰价是空闲价的两倍（tier 判据参与计价本身）
    const bp = calculateCostBreakdown(
      "tiered-model",
      usage,
      ss.getAvailableModels(),
      "openai",
      undefined,
      atPeak,
    );
    const bo = calculateCostBreakdown(
      "tiered-model",
      usage,
      ss.getAvailableModels(),
      "openai",
      undefined,
      atOff,
    );
    expect(bp.uncachedInputUSD).toBeCloseTo(bo.uncachedInputUSD * 2, 10);
    expect(bo.tier).toBe("offpeak");
    expect(bp.tier).toBe("peak");
  });
});

describe("T-B2：token 三段互斥（openai 族拆出未命中，D5 数据基础）", () => {
  test("openai 族：uncached + hit + write === 累计发送", () => {
    const ss = replayForensicSession();
    const r = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    expect(r.main.uncachedTokens + r.main.cacheHitTokens + r.main.cacheWriteTokens).toBe(
      r.main.promptTotal,
    );
    expect(r.main.promptTotal).toBe(2_398_645);
    expect(r.main.uncachedTokens).toBe(198_709); // 不是「含命中的原始输入」
    expect(r.main.cacheHitTokens).toBe(2_199_936);
  });

  test("anthropic 族：uncached === 累计未命中余量（不再做减法）", () => {
    const ss = new SessionState("tb2-anthropic");
    ss.updateUsage(
      "claude-test",
      {
        inputTokens: 500,
        outputTokens: 100,
        cacheReadInputTokens: 8_000,
        cacheCreationInputTokens: 1_500,
      },
      0,
      "anthropic",
    );
    const stats = ss.modelUsage["claude-test"]!;
    expect(stats.cumulativePromptTokens).toBe(500); // anthropic 的累计 = 未命中余量之和
    const n = ss.getNormalizedCacheUsage();
    expect(n.uncachedInputTokens).toBe(500); // 不是 500 - 8000 - 1500 的负数钳 0
  });

  test("byModel 的 uncached 与 main 的 uncached 同源（Σ byModel === main，防第二份算法漂移）", () => {
    // 变异自证（MUTATION-2）发现的真实盲区：byModel[].uncachedTokens 曾是
    // uncached 的第二份实现（手写 openai 减法 / anthropic 直取），把它改坏后
    // main.uncachedTokens 的断言全绿——两处口径可以各自漂移而互不报警。
    // 收口到 normalizeCacheUsage 之后用这条恒等式把两处锁在一起。
    const ss = replayForensicSession();
    // 混一个 anthropic 模型进会话（多协议下两族都要同源）
    ss.updateUsage(
      "claude-test",
      {
        inputTokens: 500,
        outputTokens: 100,
        cacheReadInputTokens: 8_000,
        cacheCreationInputTokens: 1_500,
      },
      0,
      "anthropic",
    );
    const r = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    const sumByModel = r.byModel.reduce((acc, m) => acc + m.uncachedTokens, 0);
    expect(sumByModel).toBe(r.main.uncachedTokens);
    // openai 族那行拆出了未命中（198,709），anthropic 那行是累计余量（500）
    expect(r.byModel.find((m) => m.model === MODEL)?.uncachedTokens).toBe(198_709);
    expect(r.byModel.find((m) => m.model === "claude-test")?.uncachedTokens).toBe(500);
  });
});

describe("T-B3：取证会话真实数字端到端对账（人工核过的轨迹）", () => {
  test("费用三块、token 三段、省钱、p 分位全部对上", () => {
    const ss = replayForensicSession();
    const r = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });

    // 费用（方案 2.3 节人工核对值）
    expect(r.totals.mainCostUSD).toBeCloseTo(0.085_608, 6);
    expect(r.totals.sideCostUSD).toBeCloseTo(0.064_451, 5);
    expect(r.totals.costUSD).toBeCloseTo(0.150_059, 5);

    // token（flow 口径）
    expect(r.main.uncachedTokens).toBe(198_709);
    expect(r.main.cacheHitTokens).toBe(2_199_936);
    expect(r.main.outputTokens).toBe(17_440);
    expect(r.main.promptTotal).toBe(2_398_645);
    // stock：末次请求 99,126
    expect(r.main.contextNow).toBe(99_126);

    // 省钱 = 命中 × (input − cacheRead)
    expect(r.main.savingsUSD).toBeCloseTo(0.590_67, 4);

    // p 分位（北极星铁律 1：不用均值）
    expect(r.perRequest).not.toBeNull();
    expect(r.perRequest!.count).toBe(31);
    expect(r.perRequest!.p50).toBeCloseTo(0.001_84, 5);
    expect(r.perRequest!.p95).toBeCloseTo(0.010_09, 5);
    expect(r.perRequest!.max).toBeCloseTo(0.013_70, 5);
    // 最贵第 1 名 = 第 3 次请求（prompt 56,743，缓存没热起来只命中 7,680）
    expect(r.perRequest!.top[0]).toMatchObject({ index: 3, promptTokens: 56_743, cacheHit: 7_680 });

    // 辅助调用按用途拆分（D14；label 已是具体任务名，D10 修过）
    expect(r.side.calls).toBe(6);
    const byLabel = new Map(r.side.byLabel.map((row) => [row.label, row]));
    expect(byLabel.get("fork:memory-extract")?.calls).toBe(2);
    expect(byLabel.get("fork:session-memory-update")?.calls).toBe(3);
    expect(byLabel.get("title_generation")?.calls).toBe(1);
    // 没有 agent:fork 这种分不出来的泛化标签
    expect(r.side.byLabel.some((row) => row.label === "agent:fork")).toBe(false);
  });

  test("主循环四段费用之和 === 主循环总费用（同源入账）", () => {
    const ss = replayForensicSession();
    const stats = ss.modelUsage[MODEL]!;
    const sum =
      (stats.uncachedInputUSD ?? 0) +
      (stats.cacheHitUSD ?? 0) +
      (stats.cacheWriteUSD ?? 0) +
      (stats.outputUSD ?? 0);
    expect(sum).toBeCloseTo(stats.costUSD, 12);
    expect(sum).toBeCloseTo(0.085_608, 6);
  });
});

describe("D11：单价来源 / 端点 / 高峰占比", () => {
  test("入账时记录端点（剥 query）与价格来源", () => {
    const ss = gwSession();
    ss.updateUsage(
      MODEL,
      { inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 500 },
      0,
      "openai",
      "https://uniapi.ruijie.com.cn/v1?key=sk-secret",
    );
    const stats = ss.modelUsage[MODEL]!;
    // 端点剥掉 query：key 之类的敏感串绝不能进快照
    expect(stats.pricingBaseURL).toBe("https://uniapi.ruijie.com.cn/v1");
    expect(stats.pricingBaseURL).not.toContain("sk-secret");
    // 用户手写价无 source → 按注册表/手写价口径记
    expect(stats.pricingSource).toBe("pricing");
  });

  test("会话跨高峰/空闲：peak + offpeak === costUSD，peakShare 可算", () => {
    const ss = new SessionState("d11-tiered");
    ss.setAvailableModels([
      {
        name: "tiered-model",
        provider: "openai",
        pricing: {
          input: 0.3,
          output: 1.2,
          peakWindows: [{ startHour: 1, endHour: 4 }],
          offPeakMultiplier: 0.5,
        },
      },
    ]);
    const usage = { inputTokens: 10_000, outputTokens: 100 };
    // CP-3 起 `updateUsage` 接收 `at`（分时段计价的输入），可以显式钉住档位；
    // 本用例不钉，只锁「peak + offpeak === costUSD」这个与时刻无关的恒等式。
    ss.updateUsage("tiered-model", usage, 0, "openai", undefined);
    const stats = ss.modelUsage["tiered-model"]!;
    const sum = (stats.peakCostUSD ?? 0) + (stats.offpeakCostUSD ?? 0);
    expect(sum).toBeCloseTo(stats.costUSD, 12);
    expect(stats.peakCostUSD ?? 0).toBeGreaterThanOrEqual(0);
    expect(stats.offpeakCostUSD ?? 0).toBeGreaterThanOrEqual(0);
  });

  test("buildCostReport 的 byModel 带解析到的价与 peakShare", () => {
    const ss = gwSession();
    ss.updateUsage(MODEL, { inputTokens: 1000, outputTokens: 10 }, 0, "openai", GW_BASE_URL);
    const r = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    const row = r.byModel.find((m) => m.model === MODEL);
    expect(row).toBeDefined();
    expect(row!.pricing?.input).toBeCloseTo(GW.input, 8);
    expect(row!.peakShare).toBeGreaterThan(0);
  });
});

/**
 * 方案 B4：面板 `peakShare` 与账本 `peakRatio` 的**同向**一致性。
 *
 * 为什么必须是「两侧都读」的交叉断言：两个指标口径不同（一个数费用、一个数请求次数），
 * 分别住在两层（`session/cost-report.ts` 的 `resolvePeakShare` 与 `llm/billing-sink.ts`
 * 的 `getPeakRatio`），历史上正是这两个出口**各自错了一次**才出现「越在空闲时段干活，
 * 面板越说你在付高峰价」。单侧断言只能各守一半：把 `resolvePeakShare` 的 `?? 0`
 * 改回 `?? stats.costUSD`，面板侧变 1；把 `getPeakRatio` 的空分母判据改坏，账本侧变味。
 * 这条用例两侧都读，任一侧背向就红。
 */
describe("B4 一致性：全空闲时面板 peakShare 与账本 peakRatio 同向", () => {
  /** 分时段模型：`peakWindows` 是 UTC 小时区间 `[1, 4)`。 */
  function tieredSession(id: string): SessionState {
    const ss = new SessionState(id);
    ss.setAvailableModels([
      {
        name: "tiered-model",
        provider: "openai",
        pricing: {
          input: 0.3,
          output: 1.2,
          peakWindows: [{ startHour: 1, endHour: 4 }],
          offPeakMultiplier: 0.5,
        },
      },
    ]);
    return ss;
  }

  function peakShareOf(ss: SessionState): number | undefined {
    const r = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    return r.byModel.find((m) => m.model === "tiered-model")!.peakShare;
  }

  test("全空闲：两侧同时为 0", () => {
    resetBillingSink();
    const ss = tieredSession("b4-offpeak");
    // UTC 12:00 落在 [1,4) 之外 → 空闲档。传 at 而不是靠「现在」，用例与跑测试的时刻无关。
    ss.updateUsage(
      "tiered-model",
      { inputTokens: 10_000, outputTokens: 100 },
      0,
      "openai",
      undefined,
      false,
      1,
      new Date("2026-01-01T12:00:00Z"),
    );
    const stats = ss.modelUsage["tiered-model"]!;
    // 前提自证：有费用、且确实没进高峰桶 —— 否则下面的 0 === 0 只是「两个空值相等」
    expect(stats.costUSD).toBeGreaterThan(0);
    expect(stats.peakCostUSD ?? 0).toBe(0);
    expect(stats.offpeakCostUSD ?? 0).toBeGreaterThan(0);

    // 账本侧：发生侧在算出 tier 后记一次观测量（生产路径见 billing-sink 的 recordPriceTier）
    recordPriceTier("offpeak");

    expect(getPeakRatio()).toBe(0);
    expect(peakShareOf(ss)).toBe(0);
    resetBillingSink();
  });

  test("对照（全高峰）：两侧同时为 1 —— 不是只修了 0 那半边", () => {
    resetBillingSink();
    const ss = tieredSession("b4-peak");
    ss.updateUsage(
      "tiered-model",
      { inputTokens: 10_000, outputTokens: 100 },
      0,
      "openai",
      undefined,
      false,
      1,
      new Date("2026-01-01T02:00:00Z"), // 落在 [1,4) → 高峰档
    );
    const stats = ss.modelUsage["tiered-model"]!;
    expect(stats.costUSD).toBeGreaterThan(0);
    expect(stats.peakCostUSD ?? 0).toBeGreaterThan(0);
    expect(stats.offpeakCostUSD ?? 0).toBe(0);

    recordPriceTier("peak");

    expect(getPeakRatio()).toBe(1);
    expect(peakShareOf(ss)).toBe(1);
    resetBillingSink();
  });
});

describe("D13：逐次明细环形缓冲有界（T-B10）", () => {
  test("写入 10,000 次请求，缓冲 ≤ 上限，p95 仍可算", () => {
    const ss = gwSession();
    for (let i = 0; i < 10_000; i++) {
      ss.updateUsage(MODEL, { inputTokens: 1000 + i, outputTokens: 10 }, 0, "openai", GW_BASE_URL);
    }
    const log = ss.getRequestLog();
    expect(log.length).toBeLessThanOrEqual(500);
    expect(log.length).toBeGreaterThan(0);
    const r = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    expect(r.perRequest).not.toBeNull();
    expect(r.perRequest!.p95).toBeGreaterThan(0);
    // 缓冲是有界的，但 requests 是全量计数（缓冲 ≠ 请求数）
    expect(r.main.requests).toBe(10_000);
  });

  test("/clear 清空环形缓冲（resetCounters）", () => {
    const ss = gwSession();
    ss.updateUsage(MODEL, { inputTokens: 1000, outputTokens: 10 }, 0, "openai", GW_BASE_URL);
    expect(ss.getRequestLog().length).toBe(1);
    ss.resetCounters();
    expect(ss.getRequestLog().length).toBe(0);
  });
});

describe("resume 回灌：新增字段跨 restart 不丢（D11/D12）", () => {
  test("serializeUsageSnapshot → hydrateUsage 后四段费用 / peak 拆分 / 推理 / 端点 / 来源都在", () => {
    const ss = new SessionState("hydrate-src");
    ss.setAvailableModels([
      {
        name: "tiered-model",
        provider: "openai",
        pricing: {
          input: 0.3,
          output: 1.2,
          cacheRead: 0.03,
          peakWindows: [{ startHour: 1, endHour: 4 }],
          offPeakMultiplier: 0.5,
        },
      },
    ]);
    ss.updateUsage(
      "tiered-model",
      { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 5_000, reasoningTokens: 40 },
      0,
      "openai",
      "https://gw.example.com/v1",
    );
    const stats = ss.modelUsage["tiered-model"]!;
    const before = {
      uncachedInputUSD: stats.uncachedInputUSD,
      cacheHitUSD: stats.cacheHitUSD,
      cacheWriteUSD: stats.cacheWriteUSD,
      outputUSD: stats.outputUSD,
      peakCostUSD: stats.peakCostUSD,
      offpeakCostUSD: stats.offpeakCostUSD,
      reasoningTokens: stats.reasoningTokens,
      pricingBaseURL: stats.pricingBaseURL,
      pricingSource: stats.pricingSource,
    };
    expect(before.uncachedInputUSD).toBeGreaterThan(0);
    expect(before.reasoningTokens).toBe(40);

    const restored = new SessionState("hydrate-dst");
    restored.hydrateUsage(ss.serializeUsageSnapshot());
    const rs = restored.modelUsage["tiered-model"]!;
    expect(rs.uncachedInputUSD).toBeCloseTo(before.uncachedInputUSD!, 12);
    expect(rs.cacheHitUSD).toBeCloseTo(before.cacheHitUSD!, 12);
    expect(rs.cacheWriteUSD).toBeCloseTo(before.cacheWriteUSD!, 12);
    expect(rs.outputUSD).toBeCloseTo(before.outputUSD!, 12);
    expect((rs.peakCostUSD ?? 0) + (rs.offpeakCostUSD ?? 0)).toBeCloseTo(rs.costUSD, 12);
    expect(rs.reasoningTokens).toBe(40);
    expect(rs.pricingBaseURL).toBe("https://gw.example.com/v1");
    expect(rs.pricingSource).toBe(before.pricingSource);
  });

  test("旧快照（PR-B 之前，无新字段）：carried=false，四段不冒充拆分", () => {
    // 旧快照只有 costUSD 没有四段——hydrateUsage 回灌后四段是 0 而 costUSD > 0，
    // buildCostReport 必须把它标成 carried=false（渲染层降级），不能拿 0 冒充分拆。
    const restored = new SessionState("hydrate-old");
    restored.hydrateUsage({
      totalCostUSD: 0.05,
      sideCostUSD: 0,
      totalAPIDuration: 0,
      totalToolDuration: 0,
      modelUsage: {
        "old-model": {
          inputTokens: 1000,
          stockPromptTokens: 1000,
          cumulativePromptTokens: 1000,
          outputTokens: 100,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 0,
          requests: 1,
          costUSD: 0.05,
          cacheSavingsUSD: 0.01,
          provider: "openai",
        },
      },
    });
    const r = buildCostReport(restored, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    const row = r.byModel.find((m) => m.model === "old-model")!;
    expect(row.carried).toBe(false);
    expect(row.costUSD).toBeCloseTo(0.05, 12);
  });
});

describe("T-B11：两套计价函数同值（D20 前半）", () => {
  test("同一组 usage：calculateUSDCost === SessionState.calculateCost", () => {
    const ss = gwSession();
    const cases: Array<{ model: string; usage: Usage; provider: string; baseURL?: string }> = [
      {
        model: MODEL,
        usage: { inputTokens: 121_908, outputTokens: 416, cacheReadInputTokens: 120_320 },
        provider: "openai",
        baseURL: GW_BASE_URL,
      },
      {
        model: "claude-test",
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          cacheReadInputTokens: 8_000,
          cacheCreationInputTokens: 1_500,
        },
        provider: "anthropic",
      },
      {
        model: "totally-unknown-model-zzz",
        usage: { inputTokens: 10_000, outputTokens: 100 },
        provider: "openai",
      },
      { model: "llama3", usage: { inputTokens: 50_000, outputTokens: 1_000 }, provider: "ollama" },
    ];
    for (const c of cases) {
      const a = calculateUSDCost(c.model, c.usage, ss.getAvailableModels(), c.provider, c.baseURL);
      const b = ss.calculateCost(c.model, c.usage, c.provider, c.baseURL);
      expect(Math.abs(a - b)).toBeLessThan(1e-12);
    }
  });
});

describe("sanitizedBaseURL：剥 query 不剥 path（D11）", () => {
  test("query 剥掉、path 保留、非法 URL 返回 undefined", () => {
    expect(SessionState.sanitizedBaseURL("https://gw.example.com/v1?key=sk-x")).toBe(
      "https://gw.example.com/v1",
    );
    expect(SessionState.sanitizedBaseURL("https://gw.example.com/v1/")).toBe(
      "https://gw.example.com/v1/",
    );
    expect(SessionState.sanitizedBaseURL("not a url")).toBeUndefined();
    expect(SessionState.sanitizedBaseURL("")).toBeUndefined();
  });
});
