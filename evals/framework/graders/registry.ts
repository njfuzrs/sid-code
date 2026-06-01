/**
 * Grader 注册表（T-10）
 *
 * 设计：case yaml 的 grader_type 字段 → 对应 Grader 实例。
 *   - 默认 grader_type=rubric_5d（保持 30 条 general case 向后兼容）
 *   - S1 起新增 binary_redline / structured_arch 等类型
 *   - S3 起预留 structured_behavior（Skill 行为评测）/ execution_test（SWE-bench 风格 binary）
 *
 * 不可拔插（C 档约束）：注册表本身是 eval runner 的内部组件；
 * 新 grader 类型必须在本文件显式注册——不允许运行时动态注入（避免供应链注入）。
 */

import { Rubric5dGrader } from "./rubric-5d-grader";
import { BinaryRedlineGrader } from "./binary-redline-grader";
import { StructuredArchGrader } from "./structured-arch-grader";
import { ExecutionTestGrader } from "./execution-test-grader";
import { TrajectoryMatchGrader } from "./trajectory-match-grader";
import type { Grader } from "./types";

const REGISTRY: Record<string, Grader> = {};

function register(grader: Grader): void {
  if (REGISTRY[grader.type]) {
    throw new Error(`Grader 类型重复注册: ${grader.type}`);
  }
  REGISTRY[grader.type] = grader;
}

register(new Rubric5dGrader());
register(new BinaryRedlineGrader());
register(new StructuredArchGrader());
register(new ExecutionTestGrader());
// B6-7（2026-05-30 / ADR-033）：trajectory_match 维度，M5 前仅诊断不进总分
register(new TrajectoryMatchGrader());

/** 默认 grader 类型（case yaml 不写 grader_type 时使用） */
export const DEFAULT_GRADER_TYPE = "rubric_5d";

/**
 * 按 grader_type 取 Grader 实例。
 *
 * @param graderType case yaml 的 grader_type 字段（可选）
 * @throws 类型未注册时抛错——不允许静默 fallback，强迫调用方修 case yaml
 */
export function getGrader(graderType: string | undefined): Grader {
  const t = graderType ?? DEFAULT_GRADER_TYPE;
  const g = REGISTRY[t];
  if (!g) {
    const known = Object.keys(REGISTRY).join(", ");
    throw new Error(`未知 grader_type: "${t}"；已注册: [${known}]`);
  }
  return g;
}

/** 列出所有已注册的 grader 类型（供 dashboard / CLI 列表展示） */
export function listGraderTypes(): { type: string; description: string }[] {
  return Object.values(REGISTRY).map((g) => ({ type: g.type, description: g.description }));
}
