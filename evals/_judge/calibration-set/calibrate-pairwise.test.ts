/**
 * calibrate-pairwise.test.ts — summarize 函数单测（T-13）
 */
import { describe, test, expect } from "bun:test";
import { summarize, renderSummaryMd } from "../../../scripts/eval/calibrate-pairwise";
import type { CalibrationVerdict } from "./types";

function v(opts: Partial<CalibrationVerdict>): CalibrationVerdict {
  return {
    pair_id: "P-001",
    judge: "claude-sonnet",
    order: "AB",
    judge_pick: "first",
    normalized_winner: "A",
    reason: "",
    correct: true,
    tested_at: new Date().toISOString(),
    ...opts,
  };
}

describe("summarize（pairwise calibration 汇总）", () => {
  test("空 verdicts → accuracy 为 0", () => {
    const s = summarize([], "claude-sonnet");
    expect(s.total_pairs).toBe(0);
    expect(s.accuracy_avg).toBe(0);
    expect(s.position_bias).toBe(0);
  });

  test("100% 准确 + 无 position bias", () => {
    const verdicts: CalibrationVerdict[] = [];
    for (let i = 0; i < 10; i++) {
      verdicts.push(v({ pair_id: `P-${i}`, order: "AB", normalized_winner: "A", correct: true }));
      verdicts.push(v({ pair_id: `P-${i}`, order: "BA", normalized_winner: "A", correct: true }));
    }
    const s = summarize(verdicts, "claude-sonnet");
    expect(s.total_pairs).toBe(10);
    expect(s.accuracy_avg).toBe(1.0);
    expect(s.position_bias).toBe(0); // AB 选 A 100% / BA 选 A 100% → bias=0
    expect(s.verdict_flip_rate).toBe(0);
  });

  test("AB 顺序总选第一个 / BA 顺序总选第一个 → 50% bias", () => {
    // 极端 position bias：judge 总倾向选 first，无视内容
    const verdicts: CalibrationVerdict[] = [];
    for (let i = 0; i < 10; i++) {
      // ground truth=A
      // AB 顺序：first=A → 选第一个 = A（correct）
      verdicts.push(v({ pair_id: `P-${i}`, order: "AB", normalized_winner: "A", correct: true }));
      // BA 顺序：first=B → 选第一个 = B（incorrect）
      verdicts.push(v({ pair_id: `P-${i}`, order: "BA", normalized_winner: "B", correct: false }));
    }
    const s = summarize(verdicts, "claude-sonnet");
    expect(s.accuracy_AB).toBe(1.0);
    expect(s.accuracy_BA).toBe(0);
    expect(s.position_bias).toBe(1.0); // AB 选 A 100%, BA 选 A 0% → diff = 1.0
    expect(s.verdict_flip_rate).toBe(1.0); // 全部翻转
  });

  test("verdict_flip_rate 反映 AB/BA 不一致比例", () => {
    const verdicts: CalibrationVerdict[] = [
      v({ pair_id: "P-1", order: "AB", normalized_winner: "A", correct: true }),
      v({ pair_id: "P-1", order: "BA", normalized_winner: "A", correct: true }),
      v({ pair_id: "P-2", order: "AB", normalized_winner: "A", correct: true }),
      v({ pair_id: "P-2", order: "BA", normalized_winner: "B", correct: false }),
    ];
    const s = summarize(verdicts, "claude-sonnet");
    expect(s.total_pairs).toBe(2);
    expect(s.verdict_flip_rate).toBe(0.5); // P-2 翻转，P-1 一致 → 1/2
  });
});

describe("renderSummaryMd（输出格式）", () => {
  test("包含核心指标表 + 触发动作段", () => {
    const summary = {
      judge: "claude-sonnet",
      total_pairs: 100,
      position_bias: 0.03,
      accuracy_AB: 0.85,
      accuracy_BA: 0.83,
      accuracy_avg: 0.84,
      verdict_flip_rate: 0.05,
      by_category: {},
    };
    const md = renderSummaryMd(summary, "claude-sonnet", "2026-05-26");
    expect(md).toContain("Pairwise Calibration");
    expect(md).toContain("100");
    expect(md).toContain("84.0%");
    expect(md).toContain("✅"); // 全部达标 → 触发动作段无需告警
  });

  test("强偏置时输出告警", () => {
    const summary = {
      judge: "claude-sonnet",
      total_pairs: 100,
      position_bias: 0.15,
      accuracy_AB: 0.5,
      accuracy_BA: 0.7,
      accuracy_avg: 0.6,
      verdict_flip_rate: 0.2,
      by_category: {},
    };
    const md = renderSummaryMd(summary, "claude-sonnet", "2026-05-26");
    expect(md).toContain("强偏置");
    expect(md).toContain("swap+average");
    expect(md).toContain("ensemble");
    expect(md).toContain("回退 anchor 主导");
  });
});
