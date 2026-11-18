/**
 * context-estimate-baseline 口径门禁。
 *
 * 这个脚本产出的四个数直接决定 E0/E1 判定「通过 / 不通过」，所以它自己必须被测：
 * - 分母三条铁律（只算已校准 / 排除作废重试 / 子代理分组）各有一条用例；
 * - 老轨迹（缺 PR0 四字段）必须单独计数，不能静默混进分母；
 * - blocking 截断的识别依赖 loop.ts 的横幅文案前缀，改文案要能在这里变红。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSession,
  countCompactionsFromMessages,
  countOverflowErrors,
  computeMetrics,
  pairCalls,
  parseRunSpec,
  percentile,
  toUsage,
  type CallPair,
  type TraceEvent,
} from "../../scripts/context-estimate-baseline.ts";

/** 造一条事件：data 直接平铺，与 events.jsonl 的形态一致 */
function ev(event: string, data: Record<string, unknown> = {}): TraceEvent {
  return { event, timestamp: "2026-11-18T00:00:00Z", data };
}

/** 造一次完整的模型调用（新轨迹：带 PR0 四字段 + BilledRequest） */
function call(opts: {
  index: number;
  estimated?: number;
  freed?: number;
  calibrated?: boolean;
  input: number;
  model?: string;
  provider?: string;
  agentId?: string;
  billedCount?: number;
  aborted?: boolean;
}): TraceEvent[] {
  const model = opts.model ?? "deepseek-v4";
  const provider = opts.provider ?? "openai";
  const events: TraceEvent[] = [
    ev("BeforeModel", {
      index: opts.index,
      model,
      ...(opts.estimated === undefined ? {} : { ctx_estimated_tokens: opts.estimated }),
      ...(opts.freed === undefined ? {} : { ctx_freed_tokens: opts.freed }),
      ...(opts.calibrated === undefined ? {} : { ctx_calibrated: opts.calibrated }),
      ...(opts.agentId ? { agent_id: opts.agentId } : {}),
    }),
    ev("AfterModel", {
      index: opts.index,
      model,
      usage: {
        input_tokens: opts.input,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  ];
  const billedCount = opts.billedCount ?? 1;
  for (let i = 0; i < billedCount; i++) {
    events.push(
      ev("BilledRequest", {
        pair_index: opts.index,
        provider,
        accounted: true,
        ...(opts.aborted && i === billedCount - 1 ? { reason: "aborted" } : {}),
      }),
    );
  }
  return events;
}

describe("percentile", () => {
  test("线性插值与边界", () => {
    expect(percentile([1], 0.95)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    // (n-1)*0.95 = 3.8 → 4 与 5 之间插值
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 6);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe("toUsage", () => {
  test("snake_case → Usage（camelCase）", () => {
    expect(
      toUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 5,
    });
  });
});

describe("pairCalls：pred / actual", () => {
  test("pred = est − freed，actual 走 normalizeCacheUsage 的 promptTotal", () => {
    const { calls } = pairCalls(
      call({ index: 1, estimated: 1000, freed: 200, calibrated: true, input: 800 }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.estimated).toBe(1000);
    expect(calls[0]!.freed).toBe(200);
    expect(calls[0]!.actual).toBe(800);
  });

  test("an anthropic 端点不做 input − hit（input 本就是未命中余量）", () => {
    const events = call({
      index: 1,
      estimated: 900,
      calibrated: true,
      input: 700,
      provider: "anthropic",
    });
    const after = events.find((e) => e.event === "AfterModel")!;
    (after.data!.usage as Record<string, unknown>).cache_read_input_tokens = 300;
    const { calls } = pairCalls(events);
    // anthropic：promptTotal = input + hit + write = 700 + 300 + 0
    expect(calls[0]!.actual).toBe(1000);
  });

  test("缺 ctx_estimated_tokens 的老轨迹单独计数，不进 calls", () => {
    const { calls, missingEstimateFields } = pairCalls(
      call({ index: 1, calibrated: true, input: 800 }),
    );
    expect(calls).toHaveLength(0);
    expect(missingEstimateFields).toBe(1);
  });

  test("AfterModel 缺失 → unpairedBefore，不参与指标", () => {
    const events = [
      ev("BeforeModel", { index: 1, model: "m", ctx_estimated_tokens: 100, ctx_calibrated: true }),
    ];
    const r = pairCalls(events);
    expect(r.calls).toHaveLength(0);
    expect(r.unpairedBefore).toBe(1);
  });

  test("子代理按 agent_id 分组", () => {
    const events = [
      ...call({ index: 1, estimated: 100, calibrated: true, input: 100 }),
      ...call({ index: 2, estimated: 100, calibrated: true, input: 100, agentId: "agent-x" }),
    ];
    const { calls } = pairCalls(events);
    expect(calls.map((c) => c.group)).toEqual(["main", "agent-x"]);
  });
});

describe("computeMetrics：分母三条铁律", () => {
  const base = (over: Partial<CallPair>): CallPair => ({
    index: 1,
    group: "main",
    model: "m",
    estimated: 100,
    freed: 0,
    anchor: 0,
    calibrated: true,
    actual: 100,
    retried: false,
    aborted: false,
    ...over,
  });

  const metrics = (calls: CallPair[]) =>
    computeMetrics({
      label: "T",
      sessionId: "s",
      model: "m",
      calls,
      unpairedBefore: 0,
      unpairedAfter: 0,
      missingEstimateFields: 0,
      overflowErrors: 0,
      blockingTruncations: 0,
      compactions: 0,
    });

  test("未校准调用被排除出分母", () => {
    const m = metrics([
      base({ index: 1, calibrated: true, estimated: 100 }),
      base({ index: 2, calibrated: false, estimated: 50 }),
    ]);
    expect(m.denominator).toBe(1);
    expect(m.excludedUncalibrated).toBe(1);
    expect(m.m1P95).toBeCloseTo(0, 6);
  });

  test("aborted 与重试过的调用都排除出分母（actual 是跨 attempt 累加值），各自单独计数", () => {
    const events = [
      ...call({ index: 1, estimated: 100, calibrated: true, input: 100, aborted: true }),
      ...call({ index: 2, estimated: 100, calibrated: true, input: 100, billedCount: 3 }),
      ...call({ index: 3, estimated: 100, calibrated: true, input: 100 }),
    ];
    const r = pairCalls(events);
    const m = metrics(r.calls);
    // 只剩 index 3 是「干净的一次调用」：重试轮的 actual 是两次 attempt 之和，
    // 拿它比 estimated 会让 M1/M2 同时失真，所以必须排除。
    expect(m.denominator).toBe(1);
    expect(m.excludedRetried).toBe(1);
    expect(m.excludedAborted).toBe(1);
    expect(m.retriedInDenominator).toBe(0);
  });

  test("M1 是 |err| 的 p95，M2 是带符号 err 的 p5（低估为负）", () => {
    const m = metrics([
      base({ index: 1, estimated: 100, actual: 100 }), // 0%
      base({ index: 2, estimated: 90, actual: 100 }), // -10%
      base({ index: 3, estimated: 110, actual: 100 }), // +10%
    ]);
    // |err| = [0, 10, 10] → p95 = 10
    expect(m.m1P95).toBeCloseTo(10, 6);
    // signed = [-10, 0, 10] → p5 = -9
    expect(m.m2P5).toBeCloseTo(-9, 6);
    expect(m.errP95).toBeCloseTo(9, 6);
  });

  test("estimated < freed（物理上不可能）单独计数 —— 它是口径漂移，不是估算退步", () => {
    // 为什么单列这个计数：PR2 曾把 loop 里 ctx_estimated_tokens 的取值从
    // estimateTokens()（全量历史）换成 getSendTokens()（发送量，已扣 freed），
    // 于是本脚本的 `estimated − freed` 变成双重扣减。它的现象是 M1 突然翻几倍，
    // 看起来完全像「估算质量变差」——2026-11-18 的 E1 端到端验收里 S2 就从 5.5%
    // 虚高到 117.7%。若不显式标出，下一个人会去优化错误的对象。
    const m = metrics([
      base({ index: 1, estimated: 100, freed: 0, actual: 100 }),
      base({ index: 2, estimated: 30, freed: 80, actual: 100 }), // 全量不可能小于释放量
    ]);
    expect(m.implausibleEstimates).toBe(1);
    // 全量历史恒 ≥ 释放量：正常轨迹这一格必须是 0
    const ok = metrics([base({ index: 1, estimated: 100, freed: 40, actual: 60 })]);
    expect(ok.implausibleEstimates).toBe(0);
  });
});

describe("countCompactionsFromMessages", () => {
  test("数 boundary 总数，并按「阻塞级压缩」前缀识别 blocking 截断", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-baseline-"));
    try {
      const file = join(dir, "messages.json");
      writeFileSync(
        file,
        JSON.stringify({
          kind: "messages",
          messages: [
            {
              role: "user",
              content: [],
              _meta: { compact_boundary: { summary: "阻塞级压缩：剩余 1200 tokens" } },
            },
            {
              role: "user",
              content: [],
              _meta: { compact_boundary: { summary: "紧急压缩：使用率 95%" } },
            },
            { role: "assistant", content: [] },
          ],
        }),
      );
      const r = countCompactionsFromMessages(file);
      expect(r.compactions).toBe(2);
      expect(r.blockingTruncations).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件不存在时返回 0（不抛）", () => {
    expect(countCompactionsFromMessages("/nonexistent/messages.json")).toEqual({
      compactions: 0,
      blockingTruncations: 0,
    });
  });
});

describe("countOverflowErrors", () => {
  test("识别 TurnError 与 errors.jsonl 里的上下文超限文案", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-baseline-"));
    try {
      writeFileSync(
        join(dir, "errors.jsonl"),
        `${JSON.stringify({ message: "This model's maximum context length is 128000 tokens" })}\n`,
      );
      const events = [
        ev("TurnError", { error: "context_length_exceeded" }),
        ev("TurnError", { error: "network unreachable" }),
      ];
      expect(countOverflowErrors(dir, events)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("analyzeSession：端到端（tmp 目录）", () => {
  test("从 events.jsonl + messages.json 产出完整指标", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-baseline-"));
    try {
      const sessionDir = join(dir, "20261118-000000-aaaaaaaa");
      mkdirSync(sessionDir, { recursive: true });
      const events = [
        ev("SessionStart", { model: "deepseek-v4" }),
        ...call({ index: 1, estimated: 120, freed: 20, calibrated: true, input: 100 }),
        ...call({ index: 2, estimated: 200, calibrated: false, input: 300 }),
      ];
      writeFileSync(
        join(sessionDir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n"),
      );
      writeFileSync(
        join(sessionDir, "messages.json"),
        JSON.stringify({
          messages: [
            {
              role: "user",
              content: [],
              _meta: { compact_boundary: { summary: "阻塞级压缩：剩余 10 tokens" } },
            },
          ],
        }),
      );

      const m = analyzeSession("T-run1", sessionDir);
      expect(m.label).toBe("T-run1");
      expect(m.sessionId).toBe("20261118-000000-aaaaaaaa");
      expect(m.model).toBe("deepseek-v4");
      expect(m.paired).toBe(2);
      expect(m.denominator).toBe(1);
      expect(m.m1P95).toBeCloseTo(0, 6);
      expect(m.compactions).toBe(1);
      expect(m.blockingTruncations).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseRunSpec", () => {
  test("label=id / 纯路径两种形态", () => {
    expect(parseRunSpec("S1-run1=20261118-104518-25d7a11b")).toEqual({
      label: "S1-run1",
      idOrPath: "20261118-104518-25d7a11b",
    });
    expect(parseRunSpec("/tmp/x/20261118-abc").label).toBe("20261118-abc");
  });
});
