/**
 * D5（Footer 不过滤 channelTrust）+ D6（provider 末次覆盖）—— core 侧判据。
 *
 * ## 为什么这两条必须一起测
 *
 * 两者都是「数字照常给、但要告诉用户这个数该怎么读」的标注型缺陷，落点也都在
 * `SessionState` 里：D5 的新字段 `channelTrust`、D6 的 `providerSwitched` 标记。
 * 判据放在 core 而不是 UI，是因为 UI 层一旦自己查渠道登记表 / 自己比 provider，
 * 就会与 /cost 变成两份判据（D9 的病根）。
 *
 * ## D5 的三层落点，本文件锁第 1、2 层
 *
 * 1. `SessionState.channelTrust` 字段 + `setChannelTrust()` 写入口（本文件）；
 * 2. `loop.ts` 在 `updateUsage` 之后**无条件**写（`query-loop-channel-trust.test.ts`）；
 * 3. Footer 透传 + 渲染标记（`packages/cli/tests/ui/`）。
 *
 * ## 隔离
 *
 * `readChannelTrustCached()` 有模块级 60s 缓存、路径由 `SID_CODE_CHANNEL_TRUST` 决定，
 * 所以登记表测试必须换路径并 `resetChannelTrustCache()`，否则会读到本机真实登记表。
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionState } from "@sid-code/core/session/state.ts";
import { buildCostReport } from "@sid-code/core/session/cost-report.ts";
import {
  lookupChannelTrust,
  readChannelTrustCached,
  resetChannelTrustCache,
} from "@sid-code/core/telemetry/channel-trust.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { getSideStats } from "@sid-code/core/trace/side-call-sink.ts";
import { __resetGatewayPricingForTest } from "@sid-code/core/llm/gateway-pricing.ts";

/**
 * 测试模型的定价（显式给，不走注册表/网关缓存）。
 *
 * 为什么要给：不认识的模型会走 `warnUnknownPricing` 打一条 SESSION WARN，而 D6 的用例
 * 正是用 `spyOn(getLogger(), "warn")` 的**调用次数**断言「换族才告警、只告警一次」——
 * 混进兜底价的 WARN 会让计数恒多 1，断言变成在测别的东西。
 */
const PRICING = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };

const IDLE_GATE = { busy: false, busyLabel: null, pendingLabels: [] as string[] };

let tmpDir: string;
let prevTrustEnv: string | undefined;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevTrustEnv = process.env.SID_CODE_CHANNEL_TRUST;
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "d5-trust-"));
  // 配置目录指向 tmp：定价/网关缓存不读本机真实值（与 cache-usage.test.ts 同构）
  process.env.SID_CONFIG_DIR = tmpDir;
  process.env.SID_CODE_CHANNEL_TRUST = join(tmpDir, "channel-trust.json");
  resetChannelTrustCache();
  // 网关价有模块级内存缓存：换了 SID_CONFIG_DIR 之后必须重置，否则会读到上一个用例的价
  __resetGatewayPricingForTest();
});

afterEach(() => {
  resetChannelTrustCache();
  __resetGatewayPricingForTest();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("SID_CODE_CHANNEL_TRUST", prevTrustEnv);
  restore("SID_CONFIG_DIR", prevConfigDir);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 带显式定价的会话（避免 `warnUnknownPricing` 污染 D6 的 warn 调用计数） */
function newSession(id: string): SessionState {
  const ss = new SessionState(id);
  ss.setAvailableModels([
    { name: "alias-model", provider: "openai", pricing: PRICING },
    { name: "main-model", provider: "openai", pricing: PRICING },
    { name: "fallback-model", provider: "anthropic", pricing: PRICING },
    { name: "deepseek-v4-pro", provider: "openai", pricing: PRICING },
  ]);
  return ss;
}

/** 写一份登记表：host → untrusted */
function writeUntrustedRegistry(host: string): void {
  writeFileSync(
    process.env.SID_CODE_CHANNEL_TRUST!,
    JSON.stringify({
      channels: {
        [host]: {
          host,
          verdict: "untrusted",
          failedCriteria: ["A", "B", "C", "D"],
          reason: "测试夹具：usage 三段随机跳动而总和恒定",
        },
      },
    }),
    "utf-8",
  );
  resetChannelTrustCache();
}

/** 复刻 loop.ts 的查询写法（同一入参：hostOf(baseURL) + 登记表读取缓存） */
function verdictFor(baseURL: string | undefined): "trusted" | "untrusted" | "unknown" {
  return lookupChannelTrust(SessionState.hostOf(baseURL), readChannelTrustCached()).verdict;
}

describe("D5 · 会话渠道可信度（字段 + 写入口）", () => {
  test("未写入时是 undefined（不是 unknown）—— 区分「还没入账」与「查过但没探测」", () => {
    const ss = newSession("d5-init");
    expect(ss.channelTrust).toBeUndefined();
    // 未探测过的渠道按可信处理（与 countsTowardTotals 同口径），所以标记为假
    expect(ss.isChannelUntrusted()).toBe(false);
  });

  test("untrusted 渠道：setChannelTrust 后 isChannelUntrusted() 为真", () => {
    const ss = newSession("d5-untrusted");
    ss.setChannelTrust(verdictFor("https://code.ppchat.vip/v1"));
    // 断言的是「落进去的值」，不是「某个常量」：登记表里没这个 host → unknown
    expect(ss.channelTrust).toBe("unknown");

    writeUntrustedRegistry("code.ppchat.vip");
    ss.setChannelTrust(verdictFor("https://code.ppchat.vip/v1"));
    expect(ss.channelTrust).toBe("untrusted");
    expect(ss.isChannelUntrusted()).toBe(true);
  });

  test("trusted 与 unknown 都不算不可信（警示只留给明确判过的渠道）", () => {
    const ss = newSession("d5-trusted");
    ss.setChannelTrust("trusted");
    expect(ss.isChannelUntrusted()).toBe(false);
    ss.setChannelTrust("unknown");
    expect(ss.isChannelUntrusted()).toBe(false);
  });

  test("getCacheHitRate 不按 channelTrust 过滤（滤掉会让整列消失，用户以为缓存坏了）", () => {
    const ss = newSession("d5-rate");
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 9_000 },
      10,
      "openai",
    );
    const before = ss.getCacheHitRate();
    expect(before).toBe(90);

    ss.setChannelTrust("untrusted");
    // 数字不变 —— 不可信是一个「怎么读」的标注，不是「算不算」的开关
    expect(ss.getCacheHitRate()).toBe(before);
  });

  test("resetCounters（/clear）清掉可信度：新会话在首笔入账前不该带着上一段端点的标记", () => {
    const ss = newSession("d5-clear");
    ss.setChannelTrust("untrusted");
    ss.resetCounters();
    expect(ss.channelTrust).toBeUndefined();
    expect(ss.isChannelUntrusted()).toBe(false);
  });
});

describe("D5 · /cost 的说明行（main.sessionNotes）", () => {
  function sessionWithUsage(id: string): SessionState {
    const ss = newSession(id);
    ss.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 9_000 },
      10,
      "openai",
    );
    return ss;
  }

  function mainOf(ss: SessionState) {
    return buildCostReport(ss, {
      sideStats: getSideStats(),
      cacheBreaks: [],
      gateStats: IDLE_GATE,
    }).main;
  }

  test("正常渠道：不给任何说明（不制造无谓的警示噪音）", () => {
    const ss = sessionWithUsage("cost-normal");
    expect(mainOf(ss).sessionNotes).toEqual([]);
  });

  test("untrusted 渠道：说明里写清「命中率是上游自报」", () => {
    const ss = sessionWithUsage("cost-untrusted");
    ss.setChannelTrust("untrusted");
    const notes = mainOf(ss).sessionNotes;
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("不可信");
    expect(notes[0]).toContain("命中率");
  });

  test("provider 换过族：说明里写清「命中率按末次口径」并点名模型（D6）", () => {
    const ss = newSession("cost-switched");
    ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "anthropic");
    ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "openai");
    const notes = mainOf(ss).sessionNotes;
    expect(notes.some((n) => n.includes("末次口径") && n.includes("alias-model"))).toBe(true);
  });
});

describe("D6 · provider 末次覆盖：同 model 换族时留痕 + WARN（方案 C 先止血）", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(getLogger(), "warn");
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("先 anthropic 后 openai：WARN 触发、只触发一次，(model, provider) 去重", () => {
    const ss = newSession("d6-switch");
    ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "anthropic");
    // 同族连续入账：不该告警（provider 稳定覆盖无害）
    ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "anthropic");
    expect(warnSpy).toHaveBeenCalledTimes(0);

    ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "openai");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [category, message] = warnSpy.mock.calls[0] as unknown as [string, string];
    expect(category).toBe("SESSION");
    expect(message).toContain("alias-model");
    expect(message).toContain("anthropic");
    expect(message).toContain("openai");

    // 后续继续走 openai：同一个 (model, openai) 不再刷屏
    for (let i = 0; i < 3; i++) {
      ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "openai");
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(ss.modelUsage["alias-model"]!.providerSwitched).toBe(true);
  });

  test("没有换过族时不打标（providerSwitched 保持 undefined，/cost 不出说明）", () => {
    const ss = newSession("d6-stable");
    ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "openai");
    ss.updateUsage("alias-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "openai");
    expect(ss.modelUsage["alias-model"]!.providerSwitched).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(0);
  });

  test("跨族降级（不同 model 名）不算换族：落到另一个桶，不该告警（§8.2）", () => {
    const ss = newSession("d6-fallback");
    ss.updateUsage("main-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "openai");
    ss.updateUsage("fallback-model", { inputTokens: 1_000, outputTokens: 10 }, 1, "anthropic");
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(ss.modelUsage["main-model"]!.providerSwitched).toBeUndefined();
    expect(ss.modelUsage["fallback-model"]!.providerSwitched).toBeUndefined();
  });
});
