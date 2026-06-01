/**
 * TrajectoryMatchGrader — Agent 轨迹诊断维度（B6-7/B6-8 / ADR-033 引入）
 *
 * 设计依据：
 *   - docs/eval/演进路线/agent-eval-真化路线-v1.md §8.2.2 + §15.2 v1.3 修正
 *   - docs/adr/ADR-033-TrajectoryMatchGrader-诊断维度.md
 *   - 业界对照：Strands TrajectoryEvaluator（拒绝其逐步严格对齐路线，因等价路径爆炸）
 *               Future AGI 4-D Trajectory Score（参考 milestone 概念）
 *               Langfuse Glass-box（参考 span tree 思路，但不做 OTel 转换）
 *
 * §15.2 v1.3 三条铁律（必须遵守）：
 *   1. **不进总分加权**（M5 之前）：score 仍输出 0-1，但 mandatoryPass 始终为 true，
 *      让 case 的总分由其它 grader 决定，本 grader 仅在 dims/namedScores 落诊断信号
 *   2. **不奖励短路径**：milestone 命中 + 等价类匹配是正向项；步数差**不参与正向**，
 *      仅在 step > max_steps × 2 时输出告警 reason
 *   3. **等价路径不当错误**：tool_equivalence_classes 把 grep / rg / lsp_references 视为同一组
 *
 * 评分语义（M5 之前）：
 *   - milestone 命中率 + 等价类工具匹配率，加权 60/40 出 0-1 分
 *   - dims["trajectory_milestone"]：里程碑命中率 0-1
 *   - dims["trajectory_tool_match"]：等价类工具匹配率 0-1
 *   - dims["trajectory_diagnostic"]：综合分 0-1（仅诊断，不进总分）
 *   - mandatoryPass: 始终 true（M5 前不参与 case fail 决定）
 *
 * 诊断报告输出（B6-9 联动）：
 *   - 每条 trajectory case 跑完落 _reports/sprint-S<N>/diagnostic/<case_id>.json
 *   - 字段：milestones_hit / milestones_missed / tool_class_hits / max_step_warning
 */

import { GRADER_VERSION } from "../core/judge";
import { isCompleteFailure } from "../core/runner";
import type { Grader, GraderContext, GraderResult } from "./types";
import type { DimScore } from "../core/judge";
import type { TrajectoryAssertion } from "../core/types";

/** 诊断维度独立版本（不与 5d-v4 共用，避免引入 grader 公式 bump） */
export const TRAJECTORY_MATCH_VERSION = "trajectory-v1";

interface CompactSpan {
  step_index: number;
  message_type?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export class TrajectoryMatchGrader implements Grader {
  readonly type = "trajectory_match";
  readonly description =
    "Agent 轨迹诊断维度（M5 前仅诊断，不进总分加权）—— 检查 milestone + 工具等价类，禁止奖励短路径";
  // M5 前 trajectory_match 不必依赖 agent 输出文本（agent 跑完 trajectory 已经落盘到 meta）
  // 但需要 ProviderResult.meta 中的 tools_used / total_steps，不能用 stub
  readonly requiresAgentOutput = true;

  async grade(ctx: GraderContext): Promise<GraderResult> {
    const { caseYaml, providerResult } = ctx;

    const failure = isCompleteFailure(providerResult);
    if (failure.failed) {
      return errResult(this.type, `wrapper 失败：${failure.reason}`);
    }

    const spec = caseYaml.trajectory_assertion;
    if (!spec) {
      return errResult(
        this.type,
        "case 未配置 trajectory_assertion（grader_type=trajectory_match 但无规则）",
      );
    }

    // §15.2 修正：tools_used 是低保真信号；后续 B6-6 转 trace.json 后补 spans 详细分析
    // M5 前 v1 实现：靠 tools_used + total_steps 做粗粒度诊断
    const toolsUsed = providerResult.meta.tools_used ?? [];
    const totalSteps = providerResult.meta.total_steps ?? 0;
    const spans: CompactSpan[] = []; // v2 改：从 meta.trajectory_path 读 trace.json 解析

    // ─── 1. 工具等价类匹配 ─────────────────────────
    const toolMatch = computeToolClassMatch(toolsUsed, spec);

    // ─── 2. milestone 命中率（v1 用 tool 名启发式；v2 改 LLM judge）──
    const milestoneMatch = computeMilestoneMatchHeuristic(toolsUsed, spec, spans);

    // ─── 3. 步数告警（不奖励短路径，仅长度爆炸告警） ────
    const stepWarning = computeStepWarning(totalSteps, spec);

    // ─── 综合分（仅诊断） ────────────────────────────
    const diagnosticScore =
      milestoneMatch.score * 0.6 + toolMatch.score * 0.4;

    const reasonParts: string[] = [
      `milestone 命中 ${milestoneMatch.hitCount}/${spec.milestones.length} = ${milestoneMatch.score.toFixed(2)}`,
      `工具等价类匹配 ${toolMatch.classHits}/${toolMatch.classTotal} = ${toolMatch.score.toFixed(2)}`,
    ];
    if (stepWarning) reasonParts.push(stepWarning);
    reasonParts.push("⚠️ M5 前仅诊断不进总分（ADR-033 §15.2 修正）");

    const diagDim: DimScore = {
      pass: true, // 诊断维度不影响 case pass/fail
      score: diagnosticScore,
      reason: reasonParts.join("；"),
    };
    const milestoneDim: DimScore = {
      pass: true,
      score: milestoneMatch.score,
      reason: milestoneMatch.missed.length
        ? `未命中里程碑：${milestoneMatch.missed.slice(0, 3).join(" / ")}`
        : "全部里程碑命中",
    };
    const toolDim: DimScore = {
      pass: true,
      score: toolMatch.score,
      reason: toolMatch.missed.length
        ? `等价类未触发：${toolMatch.missed.slice(0, 3).join(" / ")}`
        : "等价类全覆盖",
    };

    return {
      score: diagnosticScore, // 不为 null：让 jsonl 落诊断分；但 mandatoryPass 始终 true
      namedScores: {
        trajectory_diagnostic: diagnosticScore,
        trajectory_milestone: milestoneMatch.score,
        trajectory_tool_match: toolMatch.score,
      },
      dims: {
        trajectory_diagnostic: diagDim,
        trajectory_milestone: milestoneDim,
        trajectory_tool_match: toolDim,
      },
      // **关键**：M5 前永远 true，避免诊断维度影响总分决定
      mandatoryPass: true,
      graderType: this.type,
      graderVersion: `${GRADER_VERSION}+${TRAJECTORY_MATCH_VERSION}`,
    };
  }
}

/** 等价类匹配：每个等价组只要 tools_used 命中其中任一即视为该组 hit */
function computeToolClassMatch(
  toolsUsed: string[],
  spec: TrajectoryAssertion,
): { score: number; classTotal: number; classHits: number; missed: string[] } {
  const classes = spec.tool_equivalence_classes ?? [];
  if (classes.length === 0) {
    return { score: 1.0, classTotal: 0, classHits: 0, missed: [] };
  }
  const used = new Set(toolsUsed.map((t) => t.toLowerCase()));
  let hits = 0;
  const missed: string[] = [];
  for (const group of classes) {
    const groupHit = group.some((t) => used.has(t.toLowerCase()));
    if (groupHit) hits++;
    else missed.push(`[${group.join(",")}]`);
  }
  return {
    score: hits / classes.length,
    classTotal: classes.length,
    classHits: hits,
    missed,
  };
}

/**
 * v1 启发式 milestone 命中：把 milestone 文本里的关键词与 tools_used / spans 做粗匹配。
 * v2 计划：改 LLM judge 在 spans 序列上做语义匹配（成本高，先 v1 跑通）。
 */
function computeMilestoneMatchHeuristic(
  toolsUsed: string[],
  spec: TrajectoryAssertion,
  _spans: CompactSpan[],
): { score: number; hitCount: number; missed: string[] } {
  const milestones = spec.milestones ?? [];
  if (milestones.length === 0) {
    return { score: 1.0, hitCount: 0, missed: [] };
  }
  const lowerTools = toolsUsed.map((t) => t.toLowerCase());
  const hits: string[] = [];
  const missed: string[] = [];
  for (const ms of milestones) {
    const lower = ms.toLowerCase();
    // v1 启发：milestone 文本若提到工具/动作关键词且对应工具被调用，即视为 hit
    const toolMentioned = lowerTools.some((t) => lower.includes(t));
    // 兜底：如果 milestone 没有明确工具关键词，至少要求 agent 跑过任意工具
    const fallbackHit = lowerTools.length > 0 && /探索|读|查|定位|理解/.test(ms);
    if (toolMentioned || fallbackHit) hits.push(ms);
    else missed.push(ms);
  }
  return {
    score: hits.length / milestones.length,
    hitCount: hits.length,
    missed,
  };
}

/** 步数告警（不奖励短路径，仅长度爆炸告警，§15.2 / RL-006） */
function computeStepWarning(steps: number, spec: TrajectoryAssertion): string | null {
  const max = spec.max_steps;
  if (!max) return null;
  if (steps > max * 2) return `⚠️ 步数 ${steps} > max_steps × 2 (${max * 2}) — 探索过度`;
  if (steps > 0 && steps < Math.max(2, Math.floor((spec.milestones?.length ?? 0) / 2)))
    return `⚠️ 步数 ${steps} 太少 — 疑似过早收尾`;
  return null;
}

function errResult(type: string, reason: string): GraderResult {
  return {
    score: null,
    namedScores: { trajectory_diagnostic: null },
    dims: {
      trajectory_diagnostic: { pass: true, score: null, reason },
    },
    mandatoryPass: true, // 即便 grader 异常也不影响 case 总分（仅诊断）
    graderType: type,
    graderVersion: `${GRADER_VERSION}+${TRAJECTORY_MATCH_VERSION}`,
  };
}
