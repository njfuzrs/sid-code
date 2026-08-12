/**
 * cache-bench 的聚合与驱动逻辑（P1-1 / T3）
 *
 * 为什么值得测：这套数字是博客里"稳态命中率 95%+"这类说法的**唯一来源**。
 * 除法写错一处，结论就是错的，而错的方向恰好是"看起来更好" ——
 * 排除 r1 的口径若不小心把分母也一起排除，命中率会凭空变高。
 *
 * 全部用注入的假发送器，不打真渠道（判据本身与网络无关）。
 */

import { describe, expect, test } from "bun:test";
import {
  benchModel,
  roundHitRate,
  summarizeRounds,
  toInternalUsage,
  usesResponsesAPI,
  type RoundResult,
} from "@sid-code/core/telemetry/cache-bench-core.ts";

const r = (round: number, promptTotal: number, cacheHit: number, cacheWrite = 0): RoundResult => ({
  round,
  promptTotal,
  cacheHit,
  cacheWrite,
  hitRate: roundHitRate(cacheHit, promptTotal),
  costUSD: 0,
});

describe("summarizeRounds：两个口径", () => {
  test("稳态排除 r1，全轮包含 r1", () => {
    // r1 冷启动 0 命中，r2/r3 满命中
    const s = summarizeRounds([r(1, 1000, 0), r(2, 1000, 950), r(3, 1000, 950)]);
    // 稳态：1900/2000
    expect(s.steadyStateHitRate).toBeCloseTo(0.95, 6);
    // 全轮：1900/3000 —— 明显被 r1 拉低，这正是要分两个口径的理由
    expect(s.overallHitRate).toBeCloseTo(1900 / 3000, 6);
  });

  test("稳态口径排除 r1 时分子分母必须同步排除", () => {
    // 若只从分子里减掉 r1 的命中、分母仍算全量，会得到 1900/3000；
    // 若分母减了而分子没减，会得到 >1 的荒谬值。锚死正确值。
    const s = summarizeRounds([r(1, 500, 0), r(2, 1500, 1500)]);
    expect(s.steadyStateHitRate).toBe(1);
    expect(s.overallHitRate).toBeCloseTo(1500 / 2000, 6);
  });

  test("按 token 加权而非对逐轮百分比取算术平均", () => {
    // 一个小轮次 100% + 一个大轮次 50%：算术平均给 75%，加权给 ~52%。
    // 加权才等于"这些请求总共省了几成输入"。
    const s = summarizeRounds([r(1, 10, 0), r(2, 100, 100), r(3, 10000, 5000)]);
    expect(s.steadyStateHitRate).toBeCloseTo(5100 / 10100, 6);
    expect(s.steadyStateHitRate).not.toBeCloseTo(0.75, 2);
  });

  test("轮数不足 2 时稳态为 null，不是 0", () => {
    // 0 与 null 的区别很重要：0 会被读成"缓存完全没生效"，
    // null 说的是"样本不够，无从判断"。
    const s = summarizeRounds([r(1, 1000, 0)]);
    expect(s.steadyStateHitRate).toBeNull();
    expect(s.overallHitRate).toBe(0);
  });

  test("空输入两个口径都是 null", () => {
    const s = summarizeRounds([]);
    expect(s.steadyStateHitRate).toBeNull();
    expect(s.overallHitRate).toBeNull();
  });

  test("promptTotal 全为 0 时返回 null 而非 NaN", () => {
    // 0/0 会产出 NaN，而 NaN 一路传到输出会显示成诡异的 "NaN%"
    const s = summarizeRounds([r(1, 0, 0), r(2, 0, 0)]);
    expect(s.steadyStateHitRate).toBeNull();
    expect(s.overallHitRate).toBeNull();
  });
});

describe("roundHitRate", () => {
  test("promptTotal 为 0 记 0，不产出 NaN", () => {
    expect(roundHitRate(0, 0)).toBe(0);
    expect(Number.isNaN(roundHitRate(0, 0))).toBe(false);
  });

  test("正常比例", () => {
    expect(roundHitRate(950, 1000)).toBeCloseTo(0.95, 6);
  });
});

describe("benchModel 驱动", () => {
  const baseDeps = {
    config: {},
    modelConfig: { name: "fake-model" },
    provider: "openai",
    baseURL: "https://gw.example.com/v1",
    prefix: "STATIC",
    turnMessages: (round: number) => [{ role: "user", content: `q${round}` }],
    maxTokens: 32,
    costCeilingUSD: 0.5,
    log: () => {},
  };

  test("跑满轮数并给出逐轮曲线", async () => {
    const res = await benchModel({
      ...baseDeps,
      rounds: 4,
      sendOnce: async ({ messages }) => ({
        // 第一轮 0 命中，之后稳定命中
        promptTotal: 1000,
        cacheHit: messages.length > 0 && messages[0]!.content !== "q1" ? 950 : 0,
        cacheWrite: 0,
        costUSD: 0.001,
      }),
    });
    expect(res.rounds).toHaveLength(4);
    expect(res.rounds[0]!.cacheHit).toBe(0);
    expect(res.steadyStateHitRate).toBeCloseTo(0.95, 6);
    expect(res.host).toBe("gw.example.com");
    expect(res.aborted).toBeUndefined();
  });

  test("预算耗尽时提前停手，已跑轮次照常聚合", async () => {
    const res = await benchModel({
      ...baseDeps,
      rounds: 100,
      costCeilingUSD: 0.0025, // 每轮 0.001，第 3 轮前应停
      sendOnce: async () => ({ promptTotal: 1000, cacheHit: 900, cacheWrite: 0, costUSD: 0.001 }),
    });
    expect(res.rounds.length).toBeLessThan(100);
    expect(res.aborted).toContain("预算耗尽");
    // 半条曲线仍要给出数字，而不是因为中止就丢掉全部数据
    expect(res.overallHitRate).toBeCloseTo(0.9, 6);
  });

  test("请求失败记为中止，不掺进命中率", async () => {
    let n = 0;
    const res = await benchModel({
      ...baseDeps,
      rounds: 5,
      sendOnce: async () => {
        n++;
        if (n === 3) throw new Error("502 bad gateway");
        return { promptTotal: 1000, cacheHit: 900, cacheWrite: 0, costUSD: 0.0001 };
      },
    });
    // 失败的那轮不该作为"0 命中"记进去
    expect(res.rounds).toHaveLength(2);
    expect(res.aborted).toContain("502");
    expect(res.overallHitRate).toBeCloseTo(0.9, 6);
  });

  test("首轮即失败时口径为 null 而非 0", async () => {
    const res = await benchModel({
      ...baseDeps,
      rounds: 5,
      sendOnce: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(res.rounds).toHaveLength(0);
    expect(res.overallHitRate).toBeNull();
    expect(res.steadyStateHitRate).toBeNull();
    expect(res.aborted).toContain("ECONNREFUSED");
  });

  test("★hit 恒 0 但 write 每轮非零 → 记下 write 才能区分「没缓存」与「反复重写」", async () => {
    // 实跑自建网关的 anthropic 通道时踩到的：6 轮 hit 全 0，第一反应是"网关不支持"，
    // 但探针用**完全相同**的请求却稳定命中 → 说明缓存是好的，是每轮都在重新写入。
    // 只记 hit 的仪器无法区分这两种成因，而它们的修法相反。
    const res = await benchModel({
      ...baseDeps,
      provider: "anthropic",
      rounds: 3,
      sendOnce: async () => ({ promptTotal: 4000, cacheHit: 0, cacheWrite: 2584, costUSD: 0.0001 }),
    });
    expect(res.overallHitRate).toBe(0);
    // 关键断言：write 非零证明"缓存在工作，只是每轮都重写"
    expect(res.rounds.every((x) => x.cacheWrite > 0)).toBe(true);
  });

  test("前缀跨轮恒定，增量只出现在消息里", async () => {
    // 这是本脚本与探针的根本差异：前缀必须**不变**，否则测的是冷启动而非缓存
    const seenPrefixes = new Set<string>();
    const seenMsgCounts: number[] = [];
    await benchModel({
      ...baseDeps,
      rounds: 3,
      turnMessages: (round) =>
        Array.from({ length: round }, (_, i) => ({ role: "user", content: `q${i + 1}` })),
      sendOnce: async ({ prefix, messages }) => {
        seenPrefixes.add(prefix);
        seenMsgCounts.push(messages.length);
        return { promptTotal: 1000, cacheHit: 900, cacheWrite: 0, costUSD: 0.0001 };
      },
    });
    expect(seenPrefixes.size).toBe(1);
    expect(seenMsgCounts).toEqual([1, 2, 3]);
  });
});

describe("toInternalUsage：三族键名映射", () => {
  test("anthropic 读 cache_read_input_tokens", () => {
    const u = toInternalUsage(
      {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      },
      "anthropic",
    );
    expect(u.cacheReadInputTokens).toBe(900);
    expect(u.cacheCreationInputTokens).toBe(50);
  });

  test("Chat 线读 prompt_tokens_details.cached_tokens", () => {
    const u = toInternalUsage(
      { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 950 } },
      "openai",
    );
    expect(u.inputTokens).toBe(1000);
    expect(u.cacheReadInputTokens).toBe(950);
  });

  test("★Responses 线读 input_tokens_details.cached_tokens（P0-1 漏采的那个键）", () => {
    // 这一条是整个 P0-1 的核心：Responses 响应里**没有** prompt_tokens_details，
    // 只读那个键会得到 undefined → 记成 0 → 把 95% 的真实命中报成 2.2%
    const u = toInternalUsage(
      { input_tokens: 18017, output_tokens: 20, input_tokens_details: { cached_tokens: 17152 } },
      "openai",
    );
    expect(u.inputTokens).toBe(18017);
    expect(u.cacheReadInputTokens).toBe(17152);
  });

  test("deepseek 的 prompt_cache_hit_tokens 优先级最高", () => {
    const u = toInternalUsage(
      {
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 800,
        prompt_tokens_details: { cached_tokens: 1 },
      },
      "openai",
    );
    expect(u.cacheReadInputTokens).toBe(800);
  });

  test("完全没有缓存字段时记 0 而非 undefined", () => {
    const u = toInternalUsage({ prompt_tokens: 500, completion_tokens: 5 }, "openai");
    expect(u.cacheReadInputTokens).toBe(0);
  });
});

describe("usesResponsesAPI：协议分派与 registry 同源", () => {
  test("registry 里声明 openai-responses 的走 Responses 线", () => {
    // 取方案 §1.1 点名的那一族里的真实模型名
    expect(usesResponsesAPI("gpt-5.6-luna")).toBe(true);
    expect(usesResponsesAPI("gpt-5.4")).toBe(true);
  });

  test("Chat 线模型不误判", () => {
    expect(usesResponsesAPI("glm-5.2")).toBe(false);
    expect(usesResponsesAPI("deepseek-chat")).toBe(false);
  });

  test("registry 查不到时按 Chat 线处理（猜错协议比不猜更糟）", () => {
    expect(usesResponsesAPI("some-model-nobody-has-heard-of-xyz")).toBe(false);
  });
});
