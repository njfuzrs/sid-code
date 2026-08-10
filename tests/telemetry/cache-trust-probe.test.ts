/**
 * 渠道可信度判据测试（T2 / P0-4）
 *
 * 判据写错的代价是双向的：给可信渠道扣上"造数据"的帽子，或者放过一个真在造数的渠道。
 * 所以判定逻辑（judgeSamples）做成纯函数单独测，**不靠真花钱打真渠道来验证**。
 *
 * 样本用 2026-08-08 实测的真实数字（方案 §1.3），不手编理想化数据：
 *   ppchat（不可信）：全新前缀 r1 就 read=13860；同前缀 ×5 三段跳动而 sum 恒定 13159
 *   自建网关对照组（可信）：同款判据下行为完全正确
 */

import { describe, test, expect } from "bun:test";
import {
  judgeSamples,
  runProbe,
  isExplicitCacheProtocol,
  type LabeledSample,
  type UsageSample,
} from "../../src/telemetry/cache-trust-probe-core.ts";

const NOW = 1_786_152_040;

function u(inputTokens: number, cacheRead: number, cacheWrite: number): UsageSample {
  return { inputTokens, cacheRead, cacheWrite, sum: inputTokens + cacheRead + cacheWrite, costUSD: 0.001 };
}

function s(label: string, criterion: LabeledSample["criterion"], usage: UsageSample): LabeledSample {
  return { label, criterion, usage };
}

describe("判据 A：全新前缀首发不应命中", () => {
  test("r1 就报大量命中 → untrusted（实测 ppchat 形状）", () => {
    // 实测：r1 in=225 read=13860 create=2485 sum=16570
    const v = judgeSamples("code.ppchat.vip", "claude-sonnet-4-6", [s("A", "A", u(225, 13860, 2485))], NOW);
    expect(v.verdict).toBe("untrusted");
    expect(v.failedCriteria).toContain("A");
    expect(v.reason).toContain("13860");
  });

  test("r1 命中 0 → 该判据通过（实测可信渠道形状）", () => {
    const v = judgeSamples("api.uniapi.io", "claude-sonnet-5", [s("A", "A", u(18017, 0, 17152))], NOW);
    expect(v.failedCriteria ?? []).not.toContain("A");
    expect(v.verdict).toBe("trusted");
  });
});

describe("判据 B：不打 cache_control 不应命中", () => {
  test("未打断点仍报命中 → untrusted（实测 ppchat 形状）", () => {
    // 实测：r1 in=700 read=12239 create=3439 sum=16378
    const v = judgeSamples("code.ppchat.vip", "claude-sonnet-4-6", [s("B", "B", u(700, 12239, 3439))], NOW);
    expect(v.verdict).toBe("untrusted");
    expect(v.failedCriteria).toContain("B");
  });

  test("OpenAI 族是自动前缀缓存，该判据不适用（避免假阳性）", () => {
    // 自动缓存下"不打标记也命中"是**正常**的，所以驱动层不该跑 B
    expect(isExplicitCacheProtocol("anthropic")).toBe(true);
    expect(isExplicitCacheProtocol("openai")).toBe(false);
  });

  /**
   * 实跑对照抓到的假阳性：B 必须用**独立的全新前缀**。
   *
   * Anthropic 的 cache_control 只决定"写不写缓存"，**读是自动的** —— 判据 A 已经把
   * 前缀写进缓存后，B 复用同一前缀即便不打标记也会正常命中。第一版就是这么排的，
   * 把行为完全正确的自建网关对照组（A 冷启动 create=1970、后续稳定 read=1970）
   * 判成了 untrusted。
   */
  test("B 用独立前缀：驱动层不得把 A 的前缀复用给 B", async () => {
    const seen: string[] = [];
    await runProbe({
      config: {},
      modelConfig: { name: "claude-sonnet-4-6" },
      provider: "anthropic",
      baseURL: "https://gw.example.com",
      host: "gw.example.com",
      rounds: 3,
      nonce: "n",
      prefix: "PREFIX-A",
      prefixForB: "PREFIX-B",
      maxTokens: 32,
      costCeilingUSD: 0.5,
      log: () => {},
      nowSeconds: () => NOW,
      sendOnce: async ({ withCacheControl, prefix }) => {
        seen.push(`${withCacheControl ? "cc" : "nocc"}:${prefix}`);
        return { inputTokens: 10, cacheRead: 0, cacheWrite: 1970, sum: 1980, costUSD: 0.001 };
      },
    });
    // 不打断点那次必须用 B 的前缀，否则会读到 A 刚写入的缓存
    expect(seen).toContain("nocc:PREFIX-B");
    expect(seen).not.toContain("nocc:PREFIX-A");
  });

  test("真实网关形状（A 冷写入 + 后续稳定命中）判 trusted，不误伤", () => {
    // 自建网关对照组实测形状：A 冷启动 read=0/create=1970，repeat 稳定 read=1970
    const v = judgeSamples("gw.example.com", "claude-sonnet-4-6", [
      s("A", "A", u(10, 0, 1970)),
      // B 用独立前缀 → 同样冷启动、无命中
      s("B", "B", u(10, 0, 1970)),
      s("r1", "repeat", u(10, 1970, 0)),
      s("r2", "repeat", u(10, 1970, 0)),
      s("r3", "repeat", u(10, 1970, 0)),
    ], NOW);
    expect(v.verdict).toBe("trusted");
  });
});

describe("判据 C：总和恒定而三段随机跳动", () => {
  test("固定总数随机三等分 → untrusted（实测 ppchat 5 轮原始数字）", () => {
    const samples = [
      s("r1", "repeat", u(31, 8654, 4474)),
      s("r2", "repeat", u(710, 7317, 5132)),
      s("r3", "repeat", u(53, 8896, 4210)),
      s("r4", "repeat", u(929, 8941, 3289)),
      s("r5", "repeat", u(409, 9724, 3026)),
    ];
    // 前置断言：这 5 组的三段之和确实全部相等（13159）—— 判据 C 的观测事实
    expect(new Set(samples.map((x) => x.usage.sum)).size).toBe(1);
    expect(samples[0]!.usage.sum).toBe(13159);

    const v = judgeSamples("code.ppchat.vip", "claude-sonnet-5", samples, NOW);
    expect(v.verdict).toBe("untrusted");
    expect(v.failedCriteria).toContain("C");
    expect(v.reason).toContain("三等分");
  });

  test("真实缓存：命中稳定、总和随对话增长 → trusted", () => {
    const samples = [
      s("r1", "repeat", u(18017, 0, 0)),
      s("r2", "repeat", u(865, 17152, 0)),
      s("r3", "repeat", u(865, 17152, 0)),
      s("r4", "repeat", u(900, 17152, 0)),
    ];
    const v = judgeSamples("api.uniapi.io", "gpt-5.6-luna", samples, NOW);
    expect(v.verdict).toBe("trusted");
  });

  test("sum 差 1~2 token 不算异常（tokenizer 边界，不能要求严格相等）", () => {
    // 命中值稳定、sum 有极小波动 → 不该判 C
    const samples = [
      s("r1", "repeat", u(1000, 17152, 0)),
      s("r2", "repeat", u(1001, 17152, 0)),
      s("r3", "repeat", u(1002, 17152, 0)),
    ];
    const v = judgeSamples("api.uniapi.io", "m", samples, NOW);
    expect(v.failedCriteria ?? []).not.toContain("C");
  });
});

describe("判据 D：命中值无规律抖动", () => {
  test("总和也在变但命中值上下乱跳 → untrusted(D)", () => {
    const samples = [
      s("r1", "repeat", u(100, 9000, 0)),
      s("r2", "repeat", u(500, 3000, 0)),
      s("r3", "repeat", u(200, 8000, 0)),
      s("r4", "repeat", u(900, 2000, 0)),
    ];
    const v = judgeSamples("weird.example", "m", samples, NOW);
    expect(v.verdict).toBe("untrusted");
    expect(v.failedCriteria).toContain("D");
    // C 不成立（总和在变），只该记 D
    expect(v.failedCriteria).not.toContain("C");
  });

  test("单调递增的命中值是正常的（缓存逐步覆盖更多前缀）", () => {
    const samples = [
      s("r1", "repeat", u(18000, 0, 0)),
      s("r2", "repeat", u(9000, 9000, 0)),
      s("r3", "repeat", u(1000, 17000, 0)),
    ];
    const v = judgeSamples("api.uniapi.io", "m", samples, NOW);
    expect(v.verdict).toBe("trusted");
  });
});

describe("样本不足时判 unknown，不给清白证明", () => {
  test("零样本 → unknown", () => {
    const v = judgeSamples("h", "m", [], NOW);
    expect(v.verdict).toBe("unknown");
    // 没抓到问题 ≠ 可信：一次失败的探测不能记成清白证明
    expect(v.verdict).not.toBe("trusted");
  });

  /**
   * 实跑抓到的坑：把线上 snake_case usage 喂给吃 camelCase 的 normalizeCacheUsage，
   * 三段全读成 0 —— 而"零命中"让四条判据**全部通过**，探针给一个正在造数的渠道
   * 发了张清白证明。
   *
   * 这是探针的根本风险：所有判据都在找"不该出现的命中"，所以**采集断裂**
   *（永远读到 0）会伪装成"完美可信"。必须显式拒绝。
   */
  test("样本齐全但 usage 三段全为 0 → unknown，绝不发清白证明", () => {
    const zeros = [
      s("A", "A", u(0, 0, 0)),
      s("B", "B", u(0, 0, 0)),
      s("r1", "repeat", u(0, 0, 0)),
      s("r2", "repeat", u(0, 0, 0)),
      s("r3", "repeat", u(0, 0, 0)),
    ];
    const v = judgeSamples("code.ppchat.vip", "claude-sonnet-5", zeros, NOW);
    expect(v.verdict).toBe("unknown");
    expect(v.verdict).not.toBe("trusted");
    expect(v.reason).toContain("读数管线");
  });

  test("只有 2 轮 repeat（不足 3）时不跑 C/D", () => {
    const v = judgeSamples("h", "m", [
      s("r1", "repeat", u(100, 9000, 0)),
      s("r2", "repeat", u(900, 2000, 0)),
    ], NOW);
    expect(v.verdict).toBe("unknown");
  });
});

describe("驱动逻辑：预算护栏与中止语义", () => {
  /** 假发送器：每次固定花费，可控命中值 */
  function fakeSender(costEach: number, read = 0) {
    let calls = 0;
    return {
      get calls() { return calls; },
      send: async () => {
        calls++;
        return u(1000, read, 0) as UsageSample & { costUSD: number };
      },
      sendWithCost: async (): Promise<UsageSample> => {
        calls++;
        return { inputTokens: 1000, cacheRead: read, cacheWrite: 0, sum: 1000 + read, costUSD: costEach };
      },
    };
  }

  const baseDeps = {
    config: {},
    modelConfig: { name: "m" },
    provider: "openai",
    baseURL: "https://api.example.com/v1",
    host: "api.example.com",
    rounds: 5,
    nonce: "n",
    prefix: "p",
    maxTokens: 32,
    costCeilingUSD: 0.5,
    log: () => {},
    nowSeconds: () => NOW,
  };

  test("预算耗尽立即停手并报告已花费", async () => {
    const f = fakeSender(0.3); // 两次就超 0.5
    const r = await runProbe({ ...baseDeps, sendOnce: f.sendWithCost });
    expect(r.spentUSD).toBeGreaterThan(0);
    expect(r.aborted).toContain("预算耗尽");
    // 停手了就不该继续发满 rounds+1 次
    expect(f.calls).toBeLessThan(baseDeps.rounds + 1);
  });

  test("中止且未定罪时判定落回 unknown，不给 trusted 背书", async () => {
    const r = await runProbe({
      ...baseDeps,
      sendOnce: async () => { throw new Error("connect ETIMEDOUT"); },
    });
    expect(r.aborted).toContain("connect ETIMEDOUT");
    expect(r.verdict.verdict).toBe("unknown");
  });

  test("OpenAI 族跳过判据 B（不发那次请求）", async () => {
    let withoutCacheControlCalls = 0;
    await runProbe({
      ...baseDeps,
      provider: "openai",
      rounds: 3,
      sendOnce: async ({ withCacheControl }) => {
        if (!withCacheControl) withoutCacheControlCalls++;
        return { inputTokens: 1000, cacheRead: 0, cacheWrite: 0, sum: 1000, costUSD: 0.0001 };
      },
    });
    // 自动前缀缓存下跑 B 会制造假阳性，所以这次请求根本不该发出
    expect(withoutCacheControlCalls).toBe(0);
  });

  test("Anthropic 会发判据 B 那次请求（不打断点）", async () => {
    let withoutCacheControlCalls = 0;
    await runProbe({
      ...baseDeps,
      provider: "anthropic",
      rounds: 3,
      sendOnce: async ({ withCacheControl }) => {
        if (!withCacheControl) withoutCacheControlCalls++;
        return { inputTokens: 1000, cacheRead: 0, cacheWrite: 0, sum: 1000, costUSD: 0.0001 };
      },
    });
    expect(withoutCacheControlCalls).toBe(1);
  });
});
