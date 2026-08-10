/**
 * Phase 3 W7: 三层 Grader — Layer 2 Trajectory Grader
 * 基于 trajectory 质量特征评分（效率、工具使用模式、错误恢复）
 */

import type { GradeResult } from "./outcome-grader.ts";

export interface TrajectoryMetrics {
  steps: number;
  tool_calls: number;
  unique_tools: string[];
  error_count: number;
  retry_count: number;
  backtrack_count: number;
  time_seconds?: number;
}

/**
 * Layer 2: Trajectory Grader — 过程质量评分
 * 不调 LLM，基于 trajectory 统计特征，毫秒级
 */
export function gradeTrajectory(
  metrics: TrajectoryMetrics,
  expected: { max_steps?: number; estimated_turns?: number },
): GradeResult {
  let score = 5.0;
  const details: Record<string, boolean | number> = {};
  const penalties: string[] = [];

  // 1. 效率评分：实际步数 vs 预期步数
  const targetSteps = expected.estimated_turns || expected.max_steps || 30;
  const stepRatio = metrics.steps / targetSteps;
  details["step_ratio"] = Math.round(stepRatio * 100) / 100;

  if (stepRatio > 2.0) {
    score -= 2.0;
    penalties.push(`步数超预期 ${stepRatio.toFixed(1)}x`);
  } else if (stepRatio > 1.5) {
    score -= 1.0;
    penalties.push(`步数偏多 ${stepRatio.toFixed(1)}x`);
  } else if (stepRatio < 0.5 && metrics.steps > 3) {
    // 比预期快很多，可能是好事
    score += 0.5;
    details["efficient"] = true;
  }

  // 2. 错误恢复：有错误但最终完成 = 正常；错误过多 = 扣分
  details["error_count"] = metrics.error_count;
  if (metrics.error_count > 5) {
    score -= 1.5;
    penalties.push(`错误过多 (${metrics.error_count})`);
  } else if (metrics.error_count > 2) {
    score -= 0.5;
    penalties.push(`有 ${metrics.error_count} 次错误`);
  }

  // 3. 重试/回溯：适度重试正常，过度重试扣分
  details["retry_count"] = metrics.retry_count;
  if (metrics.retry_count > 3) {
    score -= 1.0;
    penalties.push(`重试过多 (${metrics.retry_count})`);
  }

  // 4. 工具多样性：使用多种工具通常意味着更全面的解决方案
  details["unique_tools_count"] = metrics.unique_tools.length;
  if (metrics.unique_tools.length >= 4) {
    details["good_tool_diversity"] = true;
  }

  // 5. 回溯（撤销之前的操作）：少量正常，过多说明方向错误
  details["backtrack_count"] = metrics.backtrack_count;
  if (metrics.backtrack_count > 2) {
    score -= 1.0;
    penalties.push(`回溯过多 (${metrics.backtrack_count})`);
  }

  // 确保分数在 0-5 范围内
  score = Math.max(0, Math.min(5, score));
  score = Math.round(score * 10) / 10;

  return {
    score,
    layer: "trajectory",
    details,
    reasoning:
      penalties.length > 0
        ? `扣分原因: ${penalties.join("; ")}`
        : "过程质量良好，无明显问题",
  };
}
