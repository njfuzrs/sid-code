/**
 * D4：缓存命中率无上限 / 三个出口口径不一致（方案 §6.3）。
 *
 * ## 防什么问题
 *
 * `hit + write > promptTotal` 时（openai 口径 promptTotal = `prompt_tokens`，
 * anthropic 口径 promptTotal = `input + hit + write`），修复前三个读出口各算各的：
 *
 * | 出口 | 修复前行为 |
 * | --- | --- |
 * | `getNormalizedCacheUsage()` | `uncached = max(0, …)` 被压成 0，hit/write 照旧累加 → 恒等式破裂 |
 * | `getCacheHitRate()`（Footer） | `hit / promptTotal` 可以 > 100%（如 120） |
 * | `/cost` 的 `cacheHitRate` | 与 Footer 同源同病，只是小数位不同 |
 *
 * 修复：钳制收口在**单一事实源** `getNormalizedCacheUsage()` 的循环内，
 * 三个出口读同一份数据，天然 ≤ 100%。
 *
 * ## 夹具为什么用「anthropic 用量 + provider=openai」
 *
 * 这是真实错配形态：`input_tokens` 是**未命中余量**（不含命中），却被按 openai 口径当成
 * `prompt_tokens`（含命中）去走 `uncached = max(0, input − hit)`，于是 hit 远超 prompt。
 * 期望值全部由常量手算，不从实现反推。
 */

import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { SessionState } from "../../src/session/state.ts";
import { buildCostReport } from "../../src/session/cost-report.ts";
import { getSideStats } from "../../src/trace/side-call-sink.ts";
import { getLogger } from "../../src/debug/logger.ts";
import type { Usage } from "../../src/llm/types.ts";

const IDLE_GATE = { busy: false, busyLabel: null, pendingLabels: [] as string[] };

/** 越界 usage：anthropic 形态（input 是不含命中的余量）被按 openai 口径记账。 */
const OVERFLOW_USAGE: Usage = {
  inputTokens: 1000, // openai 口径下被当 prompt_tokens → promptTotal = 1000
  outputTokens: 100,
  cacheReadInputTokens: 5000, // hit = 5000 > promptTotal = 1000
  cacheCreationInputTokens: 800, // + write 800，合计 5800，越界 4800
};

/** 按常量手算的钳制结果（钳制顺序：先 hit 后 write，超出的都归 uncached）。 */
const EXPECT = {
  promptTotal: 1000,
  hit: 1000, // min(5000, 1000)
  write: 0, // min(800, 1000 − 1000)
  uncached: 0, // 1000 − 1000 − 0
};

/** 造一个每次 updateUsage 都越界的会话（provider 显式给 openai，不靠模型名推断）。 */
function overflowSession(id = "d4-overflow"): SessionState {
  const ss = new SessionState(id);
  ss.updateUsage("claude-3-5-sonnet", OVERFLOW_USAGE, 1, "openai");
  return ss;
}

function buildReport(ss: SessionState) {
  return buildCostReport(ss, {
    sideStats: getSideStats(),
    gateStats: IDLE_GATE,
    cacheBreaks: [],
  });
}

describe("D4 ①：getNormalizedCacheUsage 按 promptTotal 钳制，恒等式仍成立", () => {
  test("hit > promptTotal 时三段互斥且 uncached + hit + write === promptTotal", () => {
    const view = overflowSession().getNormalizedCacheUsage();
    expect(view.promptTotal).toBe(EXPECT.promptTotal);
    expect(view.cacheHitTokens).toBe(EXPECT.hit);
    expect(view.cacheWriteTokens).toBe(EXPECT.write);
    expect(view.uncachedInputTokens).toBe(EXPECT.uncached);
    expect(view.uncachedInputTokens + view.cacheHitTokens + view.cacheWriteTokens).toBe(
      view.promptTotal,
    );
  });

  test("write 在 hit 之后才钳：hit 未越界但 hit + write 越界时，write 被截到 promptTotal − hit", () => {
    const ss = new SessionState("d4-write-overflow");
    // promptTotal = 1000；hit = 600 未越界；write = 900 → 只能占 400
    ss.updateUsage(
      "gpt-4o",
      {
        inputTokens: 1000,
        outputTokens: 10,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 900,
      },
      1,
      "openai",
    );
    const view = ss.getNormalizedCacheUsage();
    expect(view.cacheHitTokens).toBe(600);
    expect(view.cacheWriteTokens).toBe(400);
    expect(view.uncachedInputTokens).toBe(0);
    expect(view.uncachedInputTokens + view.cacheHitTokens + view.cacheWriteTokens).toBe(
      view.promptTotal,
    );
  });

  test("未越界的正常 usage 不受影响（钳制是恒等变换）", () => {
    const ss = new SessionState("d4-no-overflow");
    ss.updateUsage(
      "gpt-4o",
      { inputTokens: 6000, outputTokens: 200, cacheReadInputTokens: 5000 },
      1,
      "openai",
    );
    const view = ss.getNormalizedCacheUsage();
    expect(view.cacheHitTokens).toBe(5000);
    expect(view.uncachedInputTokens).toBe(1000);
    expect(view.promptTotal).toBe(6000);
  });
});

describe("D4 ②：getCacheHitRate 恒 ≤ 100（Footer 整数契约不变）", () => {
  test("越界会话的命中率被钳到 100，不是 580", () => {
    const rate = overflowSession().getCacheHitRate();
    expect(rate).toBeLessThanOrEqual(100);
    expect(rate).toBe(100);
    // 整数契约：Footer 依赖它返回 0-100 的整数
    expect(Number.isInteger(rate)).toBe(true);
  });
});

describe("D4 ③：/cost 的 cacheHitRate 与 Footer 同源，恒 ≤ 100", () => {
  test("buildCostReport 的 main.cacheHitRate ≤ 100 且三段恒等式成立", () => {
    const ss = overflowSession("d4-cost-overflow");
    const r = buildReport(ss);
    expect(r.main.cacheHitRate).toBeDefined();
    expect(r.main.cacheHitRate!).toBeLessThanOrEqual(100);
    expect(r.main.cacheHitRate!).toBe(100);
    // 「三个出口不一致」那一半：/cost 与 Footer 必须是同一个数（小数位只是展示口径）
    expect(r.main.cacheHitRate!).toBe(ss.getCacheHitRate()!);
    expect(r.main.uncachedTokens + r.main.cacheHitTokens + r.main.cacheWriteTokens).toBe(
      r.main.promptTotal,
    );
  });
});

describe("D4 WARN：越界告警按 model::provider 去重，只报一次", () => {
  const warnSpyList: Array<ReturnType<typeof spyOn>> = [];
  let warnSpy: ReturnType<typeof spyOn> | null = null;

  function spyWarn(): ReturnType<typeof spyOn> {
    warnSpy = spyOn(getLogger(), "warn");
    warnSpyList.push(warnSpy);
    return warnSpy;
  }

  afterEach(() => {
    for (const s of warnSpyList) s.mockRestore();
    warnSpyList.length = 0;
    warnSpy = null;
  });

  /** 只数本条缺陷的告警（同会话里可能还有别的 WARN，按关键词过滤）。 */
  function overflowWarns(spy: ReturnType<typeof spyOn>): unknown[][] {
    return spy.mock.calls.filter((c: unknown[]) => String(c[1]).includes("缓存用量越界"));
  }

  test("同一条越界 usage 连续 updateUsage 两次 → 只打一条 WARN", () => {
    const spy = spyWarn();
    const ss = new SessionState("d4-warn-dedup");
    ss.updateUsage("claude-3-5-sonnet", OVERFLOW_USAGE, 1, "openai");
    ss.updateUsage("claude-3-5-sonnet", OVERFLOW_USAGE, 1, "openai");
    expect(overflowWarns(spy).length).toBe(1);
  });

  test("日志用三参形式：category + message + 结构化 data", () => {
    const spy = spyWarn();
    const ss = new SessionState("d4-warn-shape");
    ss.updateUsage("claude-3-5-sonnet", OVERFLOW_USAGE, 1, "openai");
    const call = overflowWarns(spy)[0];
    expect(call).toBeDefined();
    expect(call![0]).toBe("SESSION");
    expect(typeof call![1]).toBe("string");
    // 不是 warn(tag, obj)：data 必须是结构化对象，字段可查
    expect(call![2]).toMatchObject({ model: "claude-3-5-sonnet", provider: "openai" });
  });

  test("不同 provider 各自告警一次（去重键是 model::provider，不是 model）", () => {
    const spy = spyWarn();
    const ss = new SessionState("d4-warn-provider-key");
    ss.updateUsage("claude-3-5-sonnet", OVERFLOW_USAGE, 1, "openai");
    // anthropic 口径下 promptTotal = input + hit + write，同一 usage 按构造不越界 → 不告警
    ss.updateUsage("claude-3-5-sonnet", OVERFLOW_USAGE, 1, "anthropic");
    expect(overflowWarns(spy).length).toBe(1);
  });

  test("未越界的正常 usage 不告警（钳制不该产生噪音）", () => {
    const spy = spyWarn();
    const ss = new SessionState("d4-warn-clean");
    ss.updateUsage(
      "gpt-4o",
      { inputTokens: 6000, outputTokens: 200, cacheReadInputTokens: 5000 },
      1,
      "openai",
    );
    expect(overflowWarns(spy).length).toBe(0);
  });
});
