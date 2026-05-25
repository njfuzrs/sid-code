/**
 * pass-at-k.test.ts — Pass@1/@3/^3 计算测试（T-15）
 */
import { describe, test, expect } from "bun:test";
import { computePassAtK, renderReport } from "../../scripts/eval/pass-at-k";

interface FakeSample {
  case_id: string;
  score: number | null;
  is_median?: boolean;
  sample_index?: number;
  provider?: string;
}

function fakeSample(score: number | null, sample_index: number, caseId = "case_001"): FakeSample {
  return { case_id: caseId, score, is_median: false, sample_index };
}

describe("computePassAtK", () => {
  test("3 次都 pass → Pass@1=avg, Pass@3=1, Pass^3=1, stable=true", () => {
    const samples = [fakeSample(4.0, 0), fakeSample(4.5, 1), fakeSample(4.2, 2)];
    const s = computePassAtK(samples as never, 2.5);
    expect(s.passAt1).toBeCloseTo(4.23, 1);
    expect(s.passAt3).toBe(1);
    expect(s.passPow3).toBe(1);
    expect(s.stable).toBe(true);
  });

  test("3 次都 fail → Pass@1=avg, Pass@3=0, Pass^3=0, stable=false", () => {
    const samples = [fakeSample(1.0, 0), fakeSample(1.5, 1), fakeSample(2.0, 2)];
    const s = computePassAtK(samples as never, 2.5);
    expect(s.passAt3).toBe(0);
    expect(s.passPow3).toBe(0);
    expect(s.stable).toBe(false);
  });

  test("1 次 pass 2 次 fail → Pass@3=1, Pass^3=0, stable=false（spread 太大）", () => {
    const samples = [fakeSample(4.0, 0), fakeSample(2.0, 1), fakeSample(2.0, 2)];
    const s = computePassAtK(samples as never, 2.5);
    expect(s.passAt3).toBe(1);
    expect(s.passPow3).toBe(0);
    expect(s.stable).toBe(false); // 0/1 < 0.7
  });

  test("超过 3 次 → 取最近 3 次（按 sample_index 排序）", () => {
    const samples = [
      fakeSample(1.0, 0),
      fakeSample(1.5, 1),
      fakeSample(4.0, 2),
      fakeSample(4.0, 3),
      fakeSample(4.0, 4),
    ];
    const s = computePassAtK(samples as never, 2.5);
    // 取 sample_index 2,3,4 → 全 pass
    expect(s.passAt3).toBe(1);
    expect(s.passPow3).toBe(1);
  });

  test("score=null 当 0 处理 → 拉低 Pass@1", () => {
    const samples = [fakeSample(null, 0), fakeSample(4.0, 1), fakeSample(4.0, 2)];
    const s = computePassAtK(samples as never, 2.5);
    expect(s.passAt1).toBeCloseTo(2.67, 1);
    expect(s.passAt3).toBe(1); // 至少有 1 次 pass
    expect(s.passPow3).toBe(0); // null 当 0 → 第 0 次不 pass
  });
});

describe("renderReport", () => {
  test("生成 markdown 表 + 汇总段", () => {
    const stats = [
      {
        caseId: "case_001",
        samples: [4.0, 4.5, 4.2],
        passAt1: 4.23,
        passAt3: 1,
        passPow3: 1,
        stable: true,
      },
      {
        caseId: "case_005",
        samples: [3.0, 1.5, 2.0],
        passAt1: 2.17,
        passAt3: 1,
        passPow3: 0,
        stable: false,
      },
    ];
    const md = renderReport("sid-code-deepseek", stats, 2.5);
    expect(md).toContain("Pass@1 / Pass@3 / Pass^3");
    expect(md).toContain("case_001");
    expect(md).toContain("4.23");
    expect(md).toContain("✅");
    expect(md).toContain("🟡");
    expect(md).toContain("稳定性 spread");
  });
});
