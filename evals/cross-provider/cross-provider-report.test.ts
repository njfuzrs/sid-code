/**
 * cross-provider-report 单测（T-22）
 */
import { describe, test, expect } from "bun:test";
import { computeStats, renderReport } from "../../scripts/eval/cross-provider-report";

interface FakeRecord {
  case_id: string;
  provider: string;
  score: number | null;
  latency_ms?: number;
  meta?: {
    total_tokens?: number;
    token_breakdown?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_creation?: number;
    };
  };
  is_median?: boolean;
  tested_at: string;
  run_status?: string;
  named_scores?: Record<string, number | null>;
}

function fakeRec(overrides: Partial<FakeRecord>): FakeRecord {
  return {
    case_id: "case_001",
    provider: "sid_code_deepseek_v4_pro",
    score: 4.0,
    latency_ms: 30000,
    meta: {
      total_tokens: 5000,
      token_breakdown: { input: 4000, output: 1000, cache_read: 0, cache_creation: 0 },
    },
    is_median: true,
    tested_at: "2026-05-26T00:00:00Z",
    run_status: "success",
    ...overrides,
  };
}

describe("computeStats", () => {
  test("正常 5 个 case：correctness / cost / time 三组指标", () => {
    const records = [
      fakeRec({ case_id: "case_001", score: 4.5 }),
      fakeRec({ case_id: "case_002", score: 3.0 }),
      fakeRec({ case_id: "case_003", score: 2.0 }),
      fakeRec({ case_id: "case_004", score: 5.0 }),
      fakeRec({ case_id: "case_005", score: null, run_status: "error" }),
    ];
    const s = computeStats("sid_code_deepseek_v4_pro", records as never);
    expect(s.totalCases).toBe(5);
    expect(s.passCount).toBe(3); // 4.5/3.0/5.0 >= 2.5
    expect(s.errorCount).toBe(1);
    expect(s.avgScore).toBeCloseTo(3.625, 2); // (4.5+3.0+2.0+5.0)/4
    expect(s.avgLatencyMs).toBe(30000); // 全是 30000
    expect(s.avgTokensPerCase).toBe(5000);
    expect(s.avgCostUsd).not.toBeNull();
    expect(s.avgCostUsd!).toBeGreaterThan(0);
  });

  test("全 null score → avgScore 为 null", () => {
    const records = [
      fakeRec({ case_id: "c1", score: null }),
      fakeRec({ case_id: "c2", score: null }),
    ];
    const s = computeStats("provider_x", records as never);
    expect(s.avgScore).toBeNull();
    expect(s.passCount).toBe(0);
    expect(s.errorCount).toBe(2);
  });

  test("无 meta 字段 → avgCostUsd 与 avgTokensPerCase 为 null", () => {
    const records = [
      fakeRec({ case_id: "c1", score: 4.0, meta: undefined }),
      fakeRec({ case_id: "c2", score: 4.0, meta: undefined }),
    ];
    const s = computeStats("provider_x", records as never);
    expect(s.avgCostUsd).toBeNull();
    expect(s.avgTokensPerCase).toBeNull();
    expect(s.avgScore).toBe(4.0);
  });
});

describe("renderReport", () => {
  test("4 段输出（Correctness / Cost / Time / 设计原则）", () => {
    const stats = [
      {
        provider: "sid_code_deepseek_v4_pro",
        totalCases: 25,
        passCount: 20,
        passRate: 0.8,
        avgScore: 4.1,
        avgLatencyMs: 28000,
        avgTokensPerCase: 8000,
        avgCostUsd: 0.0123,
        errorCount: 0,
      },
      {
        provider: "claude_code_opus47",
        totalCases: 25,
        passCount: 22,
        passRate: 0.88,
        avgScore: 4.4,
        avgLatencyMs: 35000,
        avgTokensPerCase: 12000,
        avgCostUsd: 0.234,
        errorCount: 0,
      },
    ];
    const md = renderReport(stats, "2026-05-15");
    expect(md).toContain("## 1. Correctness");
    expect(md).toContain("## 2. Cost");
    expect(md).toContain("## 3. Time");
    expect(md).toContain("4. 设计原则");
    expect(md).toContain("sid_code_deepseek_v4_pro");
    expect(md).toContain("claude_code_opus47");
    expect(md).toContain("$0.0123");
    expect(md).toContain("$0.234");
  });
});
