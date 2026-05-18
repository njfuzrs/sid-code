/**
 * W11.D1 单元测试 — capability-grader 公式
 *
 * 测：
 * - countPlanSteps：识别 markdown 列表 / 序号 / Step 标题
 * - countCoverHits：关键词命中数
 * - runCheck：每种 check 类型的 pass/fail 边界
 * - aggregateCapabilityScore：assert + LLM Judge 加权
 */

import { describe, test, expect } from "bun:test";
import {
  countPlanSteps,
  countCoverHits,
  runCheck,
  runAllChecks,
  aggregateCapabilityScore,
  type GraderRule,
  type CapabilityGraderInput,
} from "../../evals/bench-runner/capability-grader.ts";

describe("countPlanSteps", () => {
  test("空内容 → 0", () => {
    expect(countPlanSteps("")).toBe(0);
  });

  test("无序列表项", () => {
    expect(countPlanSteps("- 步骤 1\n- 步骤 2\n- 步骤 3")).toBe(3);
  });

  test("有序列表项", () => {
    expect(countPlanSteps("1. 第一\n2. 第二\n3. 第三\n4. 第四")).toBe(4);
  });

  test("混合列表与标题", () => {
    const md = `# 计划

## Step 1: 准备
- 装依赖
- 改 config

## Step 2: 执行
1. 跑测试
2. 提 PR
`;
    // ## Step 1 / ## Step 2 = 2 + "- 装依赖" + "- 改 config" + "1. 跑测试" + "2. 提 PR" = 6
    expect(countPlanSteps(md)).toBe(6);
  });

  test("过滤掉 # H1 一级标题（不是 step）", () => {
    expect(countPlanSteps("# 大标题\n\n这是描述文字")).toBe(0);
  });

  test("空行不影响计数", () => {
    expect(countPlanSteps("- A\n\n\n- B\n")).toBe(2);
  });
});

describe("countCoverHits", () => {
  test("空关键词 → 0", () => {
    expect(countCoverHits("plan content", [])).toBe(0);
  });

  test("命中关键词，大小写不敏感", () => {
    const content = "需要先读 package.json 然后改 cli.ts";
    const kws = ["package.json", "CLI.TS", "test"];
    expect(countCoverHits(content, kws)).toBe(2);
  });

  test("空 plan 内容 → 0", () => {
    expect(countCoverHits("", ["a", "b"])).toBe(0);
  });
});

function buildInput(over: Partial<CapabilityGraderInput> = {}): CapabilityGraderInput {
  return {
    expected: {},
    planContent: "",
    toolsCalled: [],
    steps: 0,
    finalResponse: "",
    planUpdateCount: 0,
    ...over,
  };
}

describe("runCheck — plan_min_steps / plan_max_steps", () => {
  test("plan_min_steps PASS", () => {
    const r = runCheck(
      { type: "assert", check: "plan_min_steps", weight: 0.2 },
      buildInput({ expected: { plan_min_steps: 3 }, planContent: "- a\n- b\n- c\n- d" }),
    );
    expect(r.passed).toBe(true);
  });

  test("plan_min_steps FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "plan_min_steps", weight: 0.2 },
      buildInput({ expected: { plan_min_steps: 5 }, planContent: "- a\n- b" }),
    );
    expect(r.passed).toBe(false);
  });

  test("plan_max_steps 超出 → FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "plan_max_steps", weight: 0.1 },
      buildInput({ expected: { plan_max_steps: 3 }, planContent: "- 1\n- 2\n- 3\n- 4\n- 5" }),
    );
    expect(r.passed).toBe(false);
  });
});

describe("runCheck — plan_must_cover_any_of_hit_ge_N", () => {
  test("命中 4 个，要求 ≥ 4 → PASS", () => {
    const r = runCheck(
      { type: "assert", check: "plan_must_cover_any_of_hit_ge_4", weight: 0.25 },
      buildInput({
        expected: { plan_must_cover_any_of: ["a", "b", "c", "d", "e"] },
        planContent: "包含 a, b, c, d 但不含 e",
      }),
    );
    expect(r.passed).toBe(true);
  });

  test("命中 3 个，要求 ≥ 4 → FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "plan_must_cover_any_of_hit_ge_4", weight: 0.25 },
      buildInput({
        expected: { plan_must_cover_any_of: ["a", "b", "c", "d", "e"] },
        planContent: "只有 a 和 b 还有 c",
      }),
    );
    expect(r.passed).toBe(false);
  });

  test("hit_ge_5 边界", () => {
    const r = runCheck(
      { type: "assert", check: "plan_must_cover_any_of_hit_ge_5", weight: 0.25 },
      buildInput({
        expected: { plan_must_cover_any_of: ["a", "b", "c", "d", "e"] },
        planContent: "a b c d e 都有",
      }),
    );
    expect(r.passed).toBe(true);
  });
});

describe("runCheck — plan_must_not_have_zero_match", () => {
  test("无违禁词 → PASS", () => {
    const r = runCheck(
      { type: "assert", check: "plan_must_not_have_zero_match", weight: 0.1 },
      buildInput({
        expected: { plan_must_not_have: ["rm -rf", "drop database"] },
        planContent: "正常的 plan 内容",
      }),
    );
    expect(r.passed).toBe(true);
  });

  test("命中违禁词 → FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "plan_must_not_have_zero_match", weight: 0.1 },
      buildInput({
        expected: { plan_must_not_have: ["rm -rf"] },
        planContent: "Step 1: rm -rf node_modules",
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("rm -rf");
  });
});

describe("runCheck — execution_must_call_tools_any_of_hit", () => {
  test("any_of 命中 → PASS", () => {
    const r = runCheck(
      { type: "assert", check: "execution_must_call_tools_any_of_hit", weight: 0.1 },
      buildInput({
        expected: { execution_must_call_tools_any_of: ["edit", "exit_plan_mode"] },
        toolsCalled: ["Read", "Edit", "ExitPlanMode"],
      }),
    );
    expect(r.passed).toBe(true);
  });

  test("any_of 全不命中 → FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "execution_must_call_tools_any_of_hit", weight: 0.1 },
      buildInput({
        expected: { execution_must_call_tools_any_of: ["bash"] },
        toolsCalled: ["Read", "Write"],
      }),
    );
    expect(r.passed).toBe(false);
  });
});

describe("runCheck — fidelity_step_ratio_in_range", () => {
  test("ratio 在范围内 → PASS", () => {
    const r = runCheck(
      { type: "assert", check: "fidelity_step_ratio_in_range", weight: 0.3 },
      buildInput({
        expected: { fidelity_step_ratio_min: 0.5, fidelity_step_ratio_max: 2.5 },
        planContent: "- 1\n- 2\n- 3\n- 4", // 4 plan steps
        steps: 6, // ratio = 1.5
      }),
    );
    expect(r.passed).toBe(true);
  });

  test("ratio 超过 max → FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "fidelity_step_ratio_in_range", weight: 0.3 },
      buildInput({
        expected: { fidelity_step_ratio_min: 0.5, fidelity_step_ratio_max: 2.0 },
        planContent: "- 1\n- 2", // 2 plan steps
        steps: 10, // ratio = 5.0
      }),
    );
    expect(r.passed).toBe(false);
  });
});

describe("runCheck — premature_exit_max_plan_steps", () => {
  test("plan ≤ 3 → PASS", () => {
    const r = runCheck(
      { type: "assert", check: "premature_exit_max_plan_steps", weight: 0.4 },
      buildInput({
        expected: { premature_exit_max_plan_steps: 3 },
        planContent: "- read\n- edit\n- done",
      }),
    );
    expect(r.passed).toBe(true);
  });

  test("plan = 5 步 → FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "premature_exit_max_plan_steps", weight: 0.4 },
      buildInput({
        expected: { premature_exit_max_plan_steps: 3 },
        planContent: "- 1\n- 2\n- 3\n- 4\n- 5",
      }),
    );
    expect(r.passed).toBe(false);
  });
});

describe("runCheck — recovery_plan_update_count_min", () => {
  test("update_count ≥ min → PASS", () => {
    const r = runCheck(
      { type: "assert", check: "recovery_plan_update_count_min", weight: 0.3 },
      buildInput({
        expected: { recovery_plan_update_count_min: 2 },
        planUpdateCount: 3,
      }),
    );
    expect(r.passed).toBe(true);
  });

  test("update_count < min → FAIL", () => {
    const r = runCheck(
      { type: "assert", check: "recovery_plan_update_count_min", weight: 0.3 },
      buildInput({
        expected: { recovery_plan_update_count_min: 2 },
        planUpdateCount: 1,
      }),
    );
    expect(r.passed).toBe(false);
  });
});

describe("runCheck — 未知 check", () => {
  test("未知 check 名 → 自动 fail（带原因）", () => {
    const r = runCheck(
      { type: "assert", check: "non_existent_check", weight: 0.1 },
      buildInput(),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未知 check");
  });
});

describe("aggregateCapabilityScore", () => {
  test("纯 assert，全 PASS", () => {
    const r = aggregateCapabilityScore({
      assertResults: [
        { check: "a", passed: true, weight: 0.5, reason: "" },
        { check: "b", passed: true, weight: 0.5, reason: "" },
      ],
    });
    expect(r.score).toBe(5);
    expect(r.assertScore).toBe(5);
  });

  test("纯 assert，半数 PASS", () => {
    const r = aggregateCapabilityScore({
      assertResults: [
        { check: "a", passed: true, weight: 0.5, reason: "" },
        { check: "b", passed: false, weight: 0.5, reason: "" },
      ],
    });
    expect(r.score).toBe(2.5);
  });

  test("assert + LLM Judge 加权", () => {
    const r = aggregateCapabilityScore({
      assertResults: [
        { check: "a", passed: true, weight: 0.7, reason: "" }, // assert score = 5
      ],
      llmJudgeScore: 3,
      llmJudgeWeight: 0.3,
    });
    // (5*0.7 + 3*0.3) / 1.0 = 4.4
    expect(r.score).toBeCloseTo(4.4, 1);
    expect(r.llmScore).toBe(3);
  });

  test("无 assert 结果（全 0 weight）", () => {
    const r = aggregateCapabilityScore({ assertResults: [] });
    expect(r.score).toBe(0);
  });

  test("score 上限 5", () => {
    // 即使权重不正确导致计算 > 5，也截断到 5
    const r = aggregateCapabilityScore({
      assertResults: [{ check: "a", passed: true, weight: 1, reason: "" }],
      llmJudgeScore: 5,
      llmJudgeWeight: 1,
    });
    expect(r.score).toBeLessThanOrEqual(5);
  });
});

describe("runAllChecks", () => {
  test("分离 assert 和 llm_judge 规则", () => {
    const rules: GraderRule[] = [
      { type: "assert", check: "plan_min_steps", weight: 0.2 },
      { type: "assert", check: "plan_must_not_have_zero_match", weight: 0.1 },
      { type: "llm_judge", weight: 0.7, rubric_ref: ["completeness"] },
    ];
    const r = runAllChecks(
      rules,
      buildInput({
        expected: { plan_min_steps: 1, plan_must_not_have: ["forbidden"] },
        planContent: "- step",
      }),
    );
    expect(r.assertResults).toHaveLength(2);
    expect(r.llmRule).not.toBeNull();
    expect(r.llmRule?.weight).toBe(0.7);
  });
});
