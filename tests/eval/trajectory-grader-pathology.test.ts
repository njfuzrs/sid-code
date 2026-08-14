/**
 * P1-8 / P1-9 单测 —— evals 侧：retry_count 连续扣分 + 六个过程病态字段。
 *
 * 本文件不碰文件系统（gradeTrajectory 是纯函数），因此无需落盘隔离。
 */

import { describe, test, expect } from "bun:test";
import {
  gradeTrajectory,
  type TrajectoryMetrics,
} from "../../evals/bench-runner/trajectory-grader.ts";

/**
 * 基线 metrics：故意让前 5 项全部不扣分，这样断言到的分差只来自被测那一项。
 * `steps` 取 15 / `max_steps` 30 → stepRatio=0.5，恰好不触发"比预期快很多"的加分
 * （< 0.5 才加分），也不触发超预期扣分。
 */
const base: TrajectoryMetrics = {
  steps: 15,
  tool_calls: 15,
  unique_tools: ["read", "edit", "bash", "grep"],
  error_count: 0,
  retry_count: 0,
  backtrack_count: 0,
};
const expected = { max_steps: 30 };

describe("P1-9 · retry_count 扣分改连续函数（消除信号饱和）", () => {
  /**
   * 关键：不能直接比 score —— 总分被 clamp 在 0~5，retry=4 只扣 0.29 会顶到上限 5.0，
   * 与"没扣分"看不出区别。所以先用 error_count 把基线压低，留出扣分空间。
   *
   * 这正是原实现能长期存在而没被发现的原因之一：在满分附近，
   * 二元扣分与连续扣分的观测差异会被上下限吃掉。
   */
  const withRoom = (retry: number): number => {
    // error_count=6 扣 1.5 → 基线 3.5，足够容纳 retry 的 0~2.0 扣分
    const r = gradeTrajectory({ ...base, error_count: 6, retry_count: retry }, expected);
    return r.score;
  };

  test("retry_count=117 的扣分严格大于 =4（核心验收：量级信息不再丢失）", () => {
    const s4 = withRoom(4);
    const s117 = withRoom(117);
    expect(s117).toBeLessThan(s4);
  });

  test("扣分随量级单调递增：4 < 10 < 40 < 117", () => {
    const scores = [4, 10, 40, 117].map(withRoom);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
    // 首尾必须严格不同，否则等于没改
    expect(scores[3]).toBeLessThan(scores[0]);
  });

  test("扣分封顶 2.0（单项不得吃掉总分、淹没其它扣分项）", () => {
    // retry 极大时扣分应停在 2.0：基线 3.5 → 1.5，不会被打到 0
    const s = withRoom(100_000);
    expect(s).toBeCloseTo(1.5, 5);
  });

  test("retry_count<=3 不扣分（阈值行为保持不变）", () => {
    expect(withRoom(3)).toBeCloseTo(withRoom(0), 5);
  });

  test("扣分数值出现在 reasoning 里（让人看得出扣了多少，而非只说'过多'）", () => {
    const r = gradeTrajectory({ ...base, error_count: 6, retry_count: 117 }, expected);
    expect(r.reasoning).toContain("117");
    expect(r.reasoning).toMatch(/扣 \d\.\d\d/);
  });
});

describe("P1-8 · 六个过程病态字段进入评分与 details", () => {
  test("缺字段（undefined）不参与评分——'测不了'≠'实测为零'", () => {
    const r = gradeTrajectory(base, expected);
    expect(r.details["poll_ratio"]).toBeUndefined();
    expect(r.details["zero_yield_subagents"]).toBeUndefined();
    expect(r.details["pathology_count"]).toBeUndefined();
    expect(r.score).toBe(5);
  });

  test("poll_ratio 超阈值 → 扣分且 details 可见（可归因到 harness 而非'模型笨'）", () => {
    const r = gradeTrajectory({ ...base, poll_ratio: 0.188 }, expected);
    expect(r.details["poll_ratio"]).toBe(0.188);
    expect(r.score).toBeLessThan(5);
    expect(r.reasoning).toContain("状态轮询占比");
  });

  test("zero_yield_subagents 扣分随个数递增（1 个失败与 4 个全灭有区别）", () => {
    const s1 = gradeTrajectory(
      { ...base, error_count: 6, zero_yield_subagents: 1 },
      expected,
    ).score;
    const s4 = gradeTrajectory(
      { ...base, error_count: 6, zero_yield_subagents: 4 },
      expected,
    ).score;
    expect(s4).toBeLessThan(s1);
  });

  test("六项全部病态时合计扣分封顶 2.0（不让启发式判据主导总分）", () => {
    const r = gradeTrajectory(
      {
        ...base,
        error_count: 6, // 基线 3.5，留出空间
        poll_ratio: 0.5,
        zero_yield_subagents: 4,
        subagent_io_ratio: 208,
        edit_latency_ms: 1_116_908,
        max_unchanged_observation_run: 22,
        retry_wasted_ratio: 0.66,
      },
      expected,
    );
    expect(r.details["pathology_count"]).toBe(6);
    expect(r.score).toBeCloseTo(1.5, 5);
  });

  test("反向验收：六项全部在阈值内 → 不扣分、不进 reasoning", () => {
    const r = gradeTrajectory(
      {
        ...base,
        poll_ratio: 0.05,
        zero_yield_subagents: 0,
        subagent_io_ratio: 10,
        edit_latency_ms: 60_000,
        max_unchanged_observation_run: 0,
        retry_wasted_ratio: 0.0,
      },
      expected,
    );
    expect(r.score).toBe(5);
    expect(r.details["pathology_count"]).toBeUndefined();
    expect(r.reasoning).toBe("过程质量良好，无明显问题");
    // 健康值仍要落进 details（可对比、可做趋势），只是不扣分
    expect(r.details["poll_ratio"]).toBe(0.05);
    expect(r.details["edit_latency_s"]).toBe(60);
  });

  test("病态归因可读：低分能说出'病在哪'而不只是'重试过多'", () => {
    const r = gradeTrajectory(
      {
        ...base,
        steps: 167,
        retry_count: 117,
        error_count: 4,
        poll_ratio: 0.188,
        zero_yield_subagents: 4,
        subagent_io_ratio: 208,
        edit_latency_ms: 1_116_908,
      },
      { max_steps: 20 },
    );
    // 这是本轮的核心目的：过程病态与"模型笨"不再同形
    expect(r.reasoning).toContain("子代理零产出");
    expect(r.reasoning).toContain("状态轮询占比");
    expect(r.reasoning).toContain("首次编辑延迟");
    expect(r.details["pathology_count"]).toBe(4);
  });
});
