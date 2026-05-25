/**
 * Grader 注册表入口（T-10）
 *
 * 用法：
 *   import { getGrader } from "evals/_graders";
 *   const grader = getGrader(caseYaml.grader_type);
 *   const result = await grader.grade({ caseYaml, providerResult, skipLlmJudge, judgeSamples });
 */

export { getGrader, listGraderTypes, DEFAULT_GRADER_TYPE } from "./registry";
export type { Grader, GraderContext, GraderResult } from "./types";
