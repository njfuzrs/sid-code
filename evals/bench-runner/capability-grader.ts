/**
 * Phase 4 W11 / ADR-013 §2.5 + ADR-016 §2.4
 * Plan capability case 专用 grader
 *
 * 与 bench-runner/outcome-grader.ts 不同：
 * - 输入是 plan 文件内容 + sid-code 实跑产物（不是 task.expected 的 must_call_tools）
 * - check 类型是 capability case 专属（plan_min_steps / plan_must_cover_any_of_hit_ge_N 等）
 * - 每个 check 直接对应 yaml 中 grader[].check 字段，weighted by yaml 中 grader[].weight
 */

import type { GradeResult } from "./outcome-grader.ts";

export interface CapabilityCaseExpected {
  plan_min_steps?: number;
  plan_max_steps?: number;
  plan_must_cover_any_of?: string[];
  plan_must_not_have?: string[];
  execution_must_call_tools_any_of?: string[];
  max_steps?: number;
  fidelity_step_ratio_min?: number;
  fidelity_step_ratio_max?: number;
  premature_exit_max_plan_steps?: number;
  recovery_plan_update_count_min?: number;
  recovery_must_include_after_failure?: string[];
}

export interface CapabilityGraderInput {
  expected: CapabilityCaseExpected;
  /** 计划文件原文（plan-{ts}.md）；缺失为 "" */
  planContent: string;
  /** 实跑产物 — 工具调用 / 步数 / final_response */
  toolsCalled: string[];
  steps: number;
  finalResponse: string;
  /** plan 文件的 update 次数（recovery 维度专属，由 runner 推算） */
  planUpdateCount: number;
}

export interface CapabilityCheckResult {
  check: string;
  passed: boolean;
  weight: number;
  reason: string;
}

export interface GraderRule {
  type: "assert" | "llm_judge";
  check?: string;
  weight: number;
  rubric_ref?: string[];
}

/**
 * 数 plan 文件的步骤数
 *
 * 启发式：把以下 markdown 行视为"plan step"：
 * - "- " 列表项（top-level，不计算嵌套子项）
 * - "1. " "2. " 等有序列表项
 * - "## Step" / "### Step" / "## Phase" 等小标题
 *
 * 暴露给单测用
 */
export function countPlanSteps(planContent: string): number {
  if (!planContent) return 0;
  const lines = planContent.split("\n");
  let count = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // top-level 列表项（行首非空白后是 "- " 或 "* "）
    if (/^[-*]\s+\S/.test(line)) {
      count++;
      continue;
    }
    // 有序列表 "1. "
    if (/^\d+\.\s+\S/.test(line)) {
      count++;
      continue;
    }
    // ## Step / ### Phase 等
    if (/^#{2,4}\s+(Step|Phase|阶段|步骤|步)/i.test(line)) {
      count++;
      continue;
    }
  }
  return count;
}

/**
 * 计算 plan_must_cover_any_of_hit_ge_N 的命中数
 *
 * 暴露给单测用
 */
export function countCoverHits(planContent: string, keywords: string[]): number {
  if (!planContent || !keywords?.length) return 0;
  const lower = planContent.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return hits;
}

/**
 * 跑单条 capability check，返回 pass/fail
 *
 * 暴露给单测用
 */
export function runCheck(
  rule: GraderRule,
  input: CapabilityGraderInput,
): CapabilityCheckResult {
  const check = rule.check || "";
  const planSteps = countPlanSteps(input.planContent);
  const tools = new Set(input.toolsCalled.map((t) => t.toLowerCase()));

  switch (check) {
    case "plan_min_steps": {
      const min = input.expected.plan_min_steps ?? 1;
      const ok = planSteps >= min;
      return { check, passed: ok, weight: rule.weight, reason: `plan_steps=${planSteps} ${ok ? "≥" : "<"} ${min}` };
    }
    case "plan_max_steps": {
      const max = input.expected.plan_max_steps ?? 999;
      const ok = planSteps <= max;
      return { check, passed: ok, weight: rule.weight, reason: `plan_steps=${planSteps} ${ok ? "≤" : ">"} ${max}` };
    }
    case "plan_must_not_have_zero_match": {
      const banned = input.expected.plan_must_not_have || [];
      const lower = input.planContent.toLowerCase();
      const hit = banned.find((kw) => lower.includes(kw.toLowerCase()));
      const ok = !hit;
      return { check, passed: ok, weight: rule.weight, reason: hit ? `命中违禁词: ${hit}` : "无违禁词命中" };
    }
    case "execution_must_call_tools_any_of_hit": {
      const expected = input.expected.execution_must_call_tools_any_of || [];
      const hit = expected.some((t) => tools.has(t.toLowerCase()));
      return {
        check,
        passed: hit,
        weight: rule.weight,
        reason: hit ? `tools 命中 ${expected.filter((t) => tools.has(t.toLowerCase())).join(",")}` : `未命中 [${expected.join(",")}]`,
      };
    }
    case "fidelity_step_ratio_in_range": {
      const min = input.expected.fidelity_step_ratio_min ?? 0;
      const max = input.expected.fidelity_step_ratio_max ?? 999;
      const ratio = planSteps > 0 ? input.steps / planSteps : 0;
      const ok = ratio >= min && ratio <= max;
      return { check, passed: ok, weight: rule.weight, reason: `actual_steps/plan_steps=${ratio.toFixed(2)} 范围[${min}, ${max}]` };
    }
    case "premature_exit_max_plan_steps": {
      const max = input.expected.premature_exit_max_plan_steps ?? 3;
      const ok = planSteps <= max;
      return { check, passed: ok, weight: rule.weight, reason: `plan_steps=${planSteps} ${ok ? "≤" : ">"} ${max}` };
    }
    case "recovery_plan_update_count_min": {
      const min = input.expected.recovery_plan_update_count_min ?? 2;
      const ok = input.planUpdateCount >= min;
      return { check, passed: ok, weight: rule.weight, reason: `plan_update_count=${input.planUpdateCount} ${ok ? "≥" : "<"} ${min}` };
    }
    case "recovery_must_include_after_failure_hit": {
      const expected = input.expected.recovery_must_include_after_failure || [];
      const lower = input.planContent.toLowerCase();
      const hit = expected.some((kw) => lower.includes(kw.toLowerCase()));
      return { check, passed: hit, weight: rule.weight, reason: hit ? "fallback 关键词命中" : `未命中 [${expected.join(",")}]` };
    }
    default: {
      // plan_must_cover_any_of_hit_ge_N（动态 N）
      const m = check.match(/^plan_must_cover_any_of_hit_ge_(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        const hits = countCoverHits(input.planContent, input.expected.plan_must_cover_any_of || []);
        const ok = hits >= n;
        return { check, passed: ok, weight: rule.weight, reason: `cover_hits=${hits} ${ok ? "≥" : "<"} ${n}` };
      }
      return { check, passed: false, weight: rule.weight, reason: `未知 check: ${check}` };
    }
  }
}

/**
 * 评分聚合：assert checks 加权命中率 + LLM Judge（外部传入）
 * 返回 0-5 分
 *
 * weight 之和不强制为 1（容忍 yaml 写错，归一化时 / total_weight）
 */
export function aggregateCapabilityScore(opts: {
  assertResults: CapabilityCheckResult[];
  /** LLM Judge 返回的 0-5 分；可选 */
  llmJudgeScore?: number;
  /** LLM Judge 在 yaml 中的 weight；缺省 0 */
  llmJudgeWeight?: number;
}): { score: number; assertScore: number; llmScore: number | null; details: Record<string, string | number | boolean> } {
  const totalAssertWeight = opts.assertResults.reduce((s, r) => s + r.weight, 0);
  const passWeight = opts.assertResults.filter((r) => r.passed).reduce((s, r) => s + r.weight, 0);
  const assertRatio = totalAssertWeight > 0 ? passWeight / totalAssertWeight : 0;
  const assertScore = Math.round(assertRatio * 5 * 10) / 10;

  let finalScore = assertScore;
  if (opts.llmJudgeScore != null && opts.llmJudgeWeight && opts.llmJudgeWeight > 0) {
    const totalWeight = totalAssertWeight + opts.llmJudgeWeight;
    finalScore =
      ((assertScore * totalAssertWeight) + (opts.llmJudgeScore * opts.llmJudgeWeight)) /
      Math.max(totalWeight, 1e-6);
    finalScore = Math.round(finalScore * 10) / 10;
  }

  const details: Record<string, string | number | boolean> = {
    assert_pass_ratio: assertRatio,
    assert_score: assertScore,
  };
  for (const r of opts.assertResults) {
    details[r.check] = r.passed;
  }
  if (opts.llmJudgeScore != null) {
    details.llm_judge_score = opts.llmJudgeScore;
  }

  return {
    score: Math.min(5, Math.max(0, finalScore)),
    assertScore,
    llmScore: opts.llmJudgeScore ?? null,
    details,
  };
}

/**
 * 工具：把单条 case 的所有 grader 规则跑完
 */
export function runAllChecks(
  graderRules: GraderRule[],
  input: CapabilityGraderInput,
): { assertResults: CapabilityCheckResult[]; llmRule: GraderRule | null } {
  const assertResults: CapabilityCheckResult[] = [];
  let llmRule: GraderRule | null = null;
  for (const rule of graderRules) {
    if (rule.type === "assert") {
      assertResults.push(runCheck(rule, input));
    } else if (rule.type === "llm_judge") {
      llmRule = rule;
    }
  }
  return { assertResults, llmRule };
}

/** Wrap aggregate as GradeResult-like (兼容现有 reporting) */
export function toGradeResult(opts: {
  score: number;
  details: Record<string, string | number | boolean>;
  reasoning: string;
  layer?: string;
}): GradeResult {
  return {
    score: opts.score,
    layer: opts.layer || "capability",
    details: Object.fromEntries(
      Object.entries(opts.details).filter(([, v]) => typeof v === "boolean" || typeof v === "number"),
    ) as Record<string, boolean | number>,
    reasoning: opts.reasoning,
  };
}
