/**
 * Rubric5dGrader — 封装现有 5d-v2 的 6 维加权评分（anchor / rubric / tool / negative / efficiency / cost）
 *
 * 本类是 task-specific scorer 注册表的"默认 grader"：
 *   - case yaml 不写 grader_type → fallback 到本类
 *   - 30 条 general case（p0-core / p1-common / p2-edge）继续走本类，行为与 5d-v2 完全一致
 *
 * 实现原则（T-10）：
 *   - 不改 eval-judge.ts 内任何 grade* 函数行为；仅做面向 GraderContext 的适配封装
 *   - mandatoryPass：5d-v2 兼容期间，rubric_5d 不区分 mandatory/optional，
 *     只要 wrapper 没失败 + 反例没命中 → mandatoryPass=true（与现有 case pass 语义一致）
 *   - 后续 T-11 引入 mandatory/optional 分级时，按 case yaml 字段（如 mandatory_dimensions）扩展
 */

import {
  GRADER_VERSION,
  aggregate,
  gradeAnchorHit,
  gradeCost,
  gradeEfficiency,
  gradeNegativeAnchors,
  gradeRubric,
  gradeToolCompliance,
  makeErrorDims,
} from "../core/judge";
import { isCompleteFailure } from "../core/runner";
import { buildRubricPrompt } from "../judge/rubric-template";
import type { Grader, GraderContext, GraderResult } from "./types";
import type { DimScore } from "../core/judge";

export class Rubric5dGrader implements Grader {
  readonly type = "rubric_5d";
  readonly description =
    "5d-v5: 6 维加权（anchor 1.5 / rubric 1.5 / tool 1.5 / negative 2.0 / efficiency 0 / cost 0）";

  async grade(ctx: GraderContext): Promise<GraderResult> {
    const { caseYaml, providerResult, skipLlmJudge, judgeSamples } = ctx;

    // wrapper 失败短路：所有维度强制 null（与 eval-runner.gradeCase 行为一致）
    const failure = isCompleteFailure(providerResult);
    if (failure.failed) {
      const dims = makeErrorDims(`wrapper 失败，跳过所有维度评分：${failure.reason}`);
      const { score, namedScores } = aggregate(dims);
      return {
        score,
        namedScores,
        dims,
        mandatoryPass: false,
        graderType: this.type,
        graderVersion: GRADER_VERSION,
      };
    }

    const { output, meta } = providerResult;
    const dims: Record<string, DimScore> = {};

    dims.anchor_hit = gradeAnchorHit(
      output,
      caseYaml.expected.must_include_any_of || [],
      caseYaml.input.user_query,
    );
    dims.negative_anchor = gradeNegativeAnchors(
      output,
      caseYaml.expected.must_not_include || [],
      caseYaml.input.user_query,
    );

    if (skipLlmJudge) {
      dims.rubric_score = { pass: true, score: 1.0, reason: "跳过 LLM judge" };
    } else {
      dims.rubric_score = await gradeRubric(
        output,
        buildRubricPrompt(caseYaml),
        undefined,
        judgeSamples,
      );
    }

    dims.tool_compliance = gradeToolCompliance(meta, {
      mustCallTools: caseYaml.expected.must_call_tools,
      mustCallMode: caseYaml.expected.must_call_tools_mode,
      mustNotCallTools: caseYaml.expected.must_not_call_tools,
      mustModifyFilesIn: caseYaml.expected.must_modify_files_in,
      mustNotModifyFiles: caseYaml.expected.must_not_modify_files,
    });
    // F-12：max_steps 缺失时不再 || 15 兜底，传原值让 gradeEfficiency 落 null + reason 警示
    dims.efficiency = gradeEfficiency(meta, caseYaml.expected.max_steps, dims.rubric_score.score);
    dims.cost = gradeCost(meta);

    const { score, namedScores } = aggregate(dims);

    // mandatoryPass 判定（T-11 引入）：
    //   - 显式 mandatory_dimensions 模式：所列维度必须 pass=true（dim.pass 字段，score 可有可无）
    //     列表外的维度仅产生诊断信号（namedScores 仍写，但不影响 case pass/fail）
    //   - 缺省（5d-v2 兼容）模式：
    //       a) negative_anchor.pass（反例硬检查）—— RL 兜底
    //       b) 总分 ≥ 2.5（baseline 通过线）—— case pass 通常含义
    const mandatoryPass = this.computeMandatoryPass(dims, score, caseYaml.mandatory_dimensions);

    return {
      score,
      namedScores,
      dims,
      mandatoryPass,
      graderType: this.type,
      graderVersion: GRADER_VERSION,
    };
  }

  private computeMandatoryPass(
    dims: Record<string, DimScore>,
    score: number | null,
    mandatoryDimensions?: string[],
  ): boolean {
    // 显式 mandatory_dimensions 模式（T-11）
    if (mandatoryDimensions && mandatoryDimensions.length > 0) {
      for (const dimName of mandatoryDimensions) {
        const dim = dims[dimName];
        if (!dim) {
          // 配置错误：声明 mandatory 但 grader 没产出该维度——保守判 fail
          return false;
        }
        if (dim.pass === false) return false;
      }
      return true;
    }

    // 缺省兼容模式（5d-v2）
    const negativePass = dims.negative_anchor?.pass !== false;
    const scorePass = score === null ? false : score >= 2.5;
    return negativePass && scorePass;
  }
}
