/**
 * Grader 接口与上下文（task-specific scorer 注册表的核心抽象）
 *
 * 设计依据：docs/eval/investigations/eval-rubric-industry-survey.md §3.2 / §6.3 T-10/T-11
 * 业界对齐：Inspect AI Scorer pattern（Dataset / Solver / Scorer 三件套）；
 *           SWE Atlas mandatory + optional rubric 分级；OpenAI Graders API multi 类型。
 *
 * 关系图：
 *   case.yaml { grader_type: "rubric_5d" | "binary_redline" | "structured_arch" | ... }
 *        ↓
 *   GRADER_REGISTRY[grader_type]   ← 注册表（registry.ts）
 *        ↓
 *   Grader.grade(ctx) → GraderResult { score, namedScores, mandatoryPass, dims }
 *        ↓
 *   eval-runner.ts → _runs/*.jsonl + baseline_scores
 *
 * mandatory + optional 设计（T-11）：
 *   - mandatory dimension：进总分 + 决定 case pass/fail（任一 mandatory 不 pass = case fail）
 *   - optional dimension：仅产生诊断信号（reason / namedScores 落 jsonl，**不进总分加权**）
 *   - 5d-v2 现有 6 维（anchor / rubric / tool / negative / efficiency / cost）全部按 mandatory 处理
 *     —— 5d-v2 不区分 mandatory/optional，新设计在 task-specific-v1 起生效
 */

import type { CaseYaml } from "../_types";
import type { ProviderResult } from "../eval-runner";
import type { DimScore } from "../eval-judge";

export interface GraderContext {
  /** case yaml 文档 */
  caseYaml: CaseYaml;
  /** provider 跑出来的输出 + 元数据 */
  providerResult: ProviderResult;
  /** 是否跳过 LLM judge（debug 模式 / smoke test） */
  skipLlmJudge: boolean;
  /** judge 同输出多次采样取中位数（默认 1） */
  judgeSamples: number;
}

/**
 * Grader 评分结果。
 *
 * 与现有 gradeCase 返回值兼容（score / namedScores / dims），新增：
 *   - mandatoryPass: 所有 mandatory 维度是否全部 pass（false 即 case fail，无论加权多少）
 *   - graderType: 实际使用的 grader 类型，落 jsonl 供诊断
 */
export interface GraderResult {
  /** 加权总分（5 分制，null = 数据缺失或 wrapper 失败） */
  score: number | null;
  /** 各维度分数（兼容现有 jsonl schema） */
  namedScores: Record<string, number | null>;
  /** 完整维度分数 + reason，用于诊断 */
  dims: Record<string, DimScore>;
  /** mandatory 维度是否全部 pass（T-11 新增；rubric_5d 始终为 true 兜底） */
  mandatoryPass: boolean;
  /** 使用的 grader 类型（rubric_5d / binary_redline / structured_arch / ...） */
  graderType: string;
  /** Grader 版本号（同 eval-judge.ts GRADER_VERSION） */
  graderVersion: string;
}

/**
 * Grader 接口。
 *
 * 实现要求：
 *   1. 必须是无状态的（可被 registry 单例复用）
 *   2. grade() 必须 catch 内部异常并返回 GraderResult（不能抛出—— runner 层负责异常路径）
 *   3. mandatoryPass 必须基于 dims 真实计算（不能简单 hardcode true）
 */
export interface Grader {
  /** grader 类型标识（与 case.yaml grader_type 字段对应） */
  readonly type: string;
  /** 简短描述（用于 dashboard / 错误信息） */
  readonly description: string;
  /**
   * 是否依赖 agent 输出做评分。
   *
   * 设计：structured_arch / 纯静态文件检查类 grader 不需要 agent 输出 —— 让 runner
   *       跳过 spawn agent，直接喂空 ProviderResult 调 grade()。这避免 agent 在静态
   *       case（题面只是描述断言）上跑超时 / 浪费 token。
   *
   * 默认 true（向后兼容：rubric_5d / binary_redline 都依赖 agent 输出）。
   */
  readonly requiresAgentOutput?: boolean;
  /** 评分主入口 */
  grade(ctx: GraderContext): Promise<GraderResult>;
}
