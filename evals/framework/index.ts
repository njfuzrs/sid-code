/**
 * eval-framework 通用组件入口
 *
 * 本目录标记"通用评测框架"的边界——这些模块不依赖任何特定 agent 的代码，
 * 可以在未来独立拆仓库时直接迁移。
 *
 * 当前阶段（Phase 2）通过 re-export 明确边界，不做物理文件移动，
 * 避免大量 import 路径变更带来的风险。Phase 3 拆仓库时再做物理迁移。
 *
 * 通用组件清单：
 *   - core: eval-judge.ts, eval-runner.ts, baseline-sync.ts, _types.ts
 *   - graders: _graders/
 *   - sandbox: _sandbox/
 *   - judge: _judge/rubric-template.ts
 *   - trace: _types/agent-trace.ts
 *   - config: eval.config.yaml
 */

// === Core ===
export {
  aggregate,
  makeErrorDims,
  calcBillable,
  COST_FORMULA_VERSION,
  GRADER_VERSION,
  type DimScore,
  type AgentMeta,
  type TokenBreakdown,
} from "../eval-judge.ts";

export {
  runProviderOnce,
  runProvider,
  isRetryableError,
  isCompleteFailure,
  classifyRunStatus,
  aggregateSamples,
  writeWeekScores,
  DEFAULT_MAX_RETRIES,
  type ProviderDef,
  type ProviderResult,
  type TestResult,
} from "../eval-runner.ts";

export {
  syncBaselineScores,
  type BaselineResult,
} from "../baseline-sync.ts";

export type { CaseYaml } from "../_types.ts";

// === Graders ===
export { getGrader } from "../_graders/index.ts";
export type { Grader, GraderContext, GraderResult } from "../_graders/types.ts";

// === Sandbox ===
export { runSandbox } from "../_sandbox/index.ts";

// === Judge ===
export { buildRubricPrompt } from "../_judge/rubric-template.ts";

// === Trace ===
export {
  validateTrace,
  truncateSpanField,
  BUILTIN_AGENT_KINDS,
  TRACE_SCHEMA_VERSION,
  SPAN_FIELD_BYTE_LIMIT,
  type AgentTrace,
  type AgentKind,
  type TraceStatus,
  type TraceSpan,
  type SpanKind,
  type SpanRole,
  type ValidationResult,
} from "../_types/agent-trace.ts";
