/**
 * eval-framework 通用组件入口
 *
 * 本目录是"通用评测框架"的物理边界——这些模块不依赖任何特定 agent 的代码，
 * 可以在 Phase 3 独立拆仓库时直接迁移。
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
} from "./core/judge.ts";

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
} from "./core/runner.ts";

export { syncBaselineScores, type BaselineResult } from "./core/baseline-sync.ts";

export type { CaseYaml } from "./core/types.ts";

// === Graders ===
export { getGrader } from "./graders/index.ts";
export type { Grader, GraderContext, GraderResult } from "./graders/types.ts";

// === Sandbox ===
export { runSandbox } from "./sandbox/index.ts";

// === Judge ===
export { buildRubricPrompt } from "./judge/rubric-template.ts";

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
} from "./trace/agent-trace.ts";
