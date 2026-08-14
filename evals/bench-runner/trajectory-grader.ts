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

  // ── P1-8：过程病态六项（全部可选）──
  //
  // 为什么必须是可选：四个 adapter（sid-code / sid-code-live / claude-code / codex）
  // 各自构造 TrajectoryMetrics，改成必填会让三个非 sid-code 的 adapter 直接类型报错，
  // 而它们根本拿不到这些信号（claude-code 的轨迹里没有 sid-code 的事件流）。
  // 缺字段一律按"该项不参与评分"处理，不按 0 处理——0 是"实测为零"，
  // undefined 是"这个 provider 测不了"，两者混同会把跨 provider 对比做成假比较。
  //
  // 为什么放在 evals 侧而不只放 digest：过程病态与"模型笨"表现同形
  // （都是 steps 多 / retry 多），评估体系不引入这些字段就永远无法归因到 harness。
  // 这正是本轮要消除的核心盲区。
  //
  // 数值定义与阈值以 `packages/core/src/trace/digest.ts` 的 `ProcessPathologyStats`
  // 为唯一事实源，本处**刻意不复述阈值**——两处各写一份必然漂移。
  /** 状态查询类调用占比（0~1）。见 ProcessPathologyStats.pollRatio */
  poll_ratio?: number;
  /** 未以 completed 收尾的子代理数（保守下界，非真 yield） */
  zero_yield_subagents?: number;
  /** 子代理 input/output token 比 */
  subagent_io_ratio?: number;
  /** 首次编辑距会话开始的毫秒数 */
  edit_latency_ms?: number;
  /** 同参调用且返回值完全不变的最长连续次数（0 = 无重复劳动） */
  max_unchanged_observation_run?: number;
  /** 重试白烧 token 占已记账 input 的比例（0~1，估算值） */
  retry_wasted_ratio?: number;
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
  //
  // P1-9：扣分必须随量级连续递增，不能是二元阈值。
  // 此前是 `if (retry_count > 3) score -= 1.0`——retry_count=117（49 次同参轮询的死循环）
  // 与 retry_count=4（偶尔重试）得到**完全相同**的 −1.0，量级信息在总分上不可区分。
  // 实测后果：一次子代理 4 个全灭、1.84M token 打水漂的会话，评估只给出"重试过多"三个字，
  // 与"模型偶尔手滑"同形，无法归因到 harness 缺陷。
  //
  // 用 log 而非线性：重试次数的边际危害是递减的（4→10 次的信息量远大于 100→110 次），
  // 且必须有上界，否则单项就能把总分打到 0、淹没其它扣分项。
  // 封顶 2.0 与"步数超预期"最重档持平——它们是同一量级的过程病态。
  details["retry_count"] = metrics.retry_count;
  if (metrics.retry_count > 3) {
    const penalty = Math.min(2.0, Math.log(metrics.retry_count / 3));
    score -= penalty;
    penalties.push(`重试过多 (${metrics.retry_count}，扣 ${penalty.toFixed(2)})`);
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

  // 6. P1-8：过程病态六项。
  //
  // 目的是**归因**而不只是扣分：前 5 项测的是"做得好不好"，这 6 项测的是
  // "过程是不是病态"。两类信号在总分上都体现，但 details 里的字段名让人能一眼看出
  // "低分是因为模型笨，还是因为 harness 让它在原地轮询"——这是评估体系此前完全缺失的能力。
  //
  // 扣分总额刻意压得比前 5 项轻（单项 ≤ 0.75、六项合计封顶 2.0）：
  // 这些判据都是启发式且有合法豁免场景（等后台任务本就该轮询、只读调研本就 input 重），
  // 让它们主导总分会把"长任务"误判成"病态"。它们的首要价值是**可归因**，其次才是扣分。
  //
  // 缺字段（undefined）一律跳过，不按 0 处理：见 TrajectoryMetrics 注释，
  // "测不了"与"实测为零"必须可区分，否则跨 provider 对比是假比较。
  let pathologyPenalty = 0;
  const pathologyHits: string[] = [];
  const flagPathology = (label: string, penalty: number) => {
    pathologyPenalty += penalty;
    pathologyHits.push(label);
  };

  if (metrics.poll_ratio !== undefined) {
    details["poll_ratio"] = Math.round(metrics.poll_ratio * 1000) / 1000;
    if (metrics.poll_ratio > 0.1) {
      flagPathology(`状态轮询占比 ${(metrics.poll_ratio * 100).toFixed(1)}%`, 0.5);
    }
  }
  if (metrics.zero_yield_subagents !== undefined) {
    details["zero_yield_subagents"] = metrics.zero_yield_subagents;
    if (metrics.zero_yield_subagents > 0) {
      // 随个数递增但很快封顶：1 个失败与 4 个全灭该有区别，但不该压倒总分
      flagPathology(
        `${metrics.zero_yield_subagents} 个子代理零产出`,
        Math.min(0.75, 0.25 * metrics.zero_yield_subagents),
      );
    }
  }
  if (metrics.subagent_io_ratio !== undefined) {
    details["subagent_io_ratio"] = Math.round(metrics.subagent_io_ratio * 10) / 10;
    if (metrics.subagent_io_ratio > 50) {
      flagPathology(`子代理 IO 比 ${metrics.subagent_io_ratio.toFixed(0)}:1`, 0.5);
    }
  }
  if (metrics.edit_latency_ms !== undefined) {
    details["edit_latency_s"] = Math.round(metrics.edit_latency_ms / 1000);
    if (metrics.edit_latency_ms > 300_000) {
      flagPathology(`首次编辑延迟 ${Math.round(metrics.edit_latency_ms / 60000)}min`, 0.5);
    }
  }
  if (metrics.max_unchanged_observation_run !== undefined) {
    details["max_unchanged_observation_run"] = metrics.max_unchanged_observation_run;
    if (metrics.max_unchanged_observation_run >= 3) {
      flagPathology(`同参调用返回值连续 ${metrics.max_unchanged_observation_run} 次不变`, 0.5);
    }
  }
  if (metrics.retry_wasted_ratio !== undefined) {
    details["retry_wasted_ratio"] = Math.round(metrics.retry_wasted_ratio * 1000) / 1000;
    if (metrics.retry_wasted_ratio > 0.2) {
      flagPathology(`重试白烧占比 ${(metrics.retry_wasted_ratio * 100).toFixed(1)}%`, 0.5);
    }
  }

  if (pathologyHits.length > 0) {
    const capped = Math.min(2.0, pathologyPenalty);
    score -= capped;
    details["pathology_count"] = pathologyHits.length;
    penalties.push(
      `过程病态 ${pathologyHits.length} 项（${pathologyHits.join("、")}，扣 ${capped.toFixed(2)}）`,
    );
  }

  // 确保分数在 0-5 范围内
  score = Math.max(0, Math.min(5, score));
  score = Math.round(score * 10) / 10;

  return {
    score,
    layer: "trajectory",
    details,
    reasoning:
      penalties.length > 0 ? `扣分原因: ${penalties.join("; ")}` : "过程质量良好，无明显问题",
  };
}
