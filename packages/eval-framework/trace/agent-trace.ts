/**
 * AgentTrace v1 类型定义 + 校验函数（B6-5）
 *
 * 单一来源：`docs/eval/specs/trace-schema-v1.md` §2 字段定义 + §5 五条强约束。
 * spec 改动 → 本文件随改 → 单测保证锁定。
 *
 * 用法：
 *   import { type AgentTrace, validateTrace } from "evals/_types/agent-trace";
 *   const result = validateTrace(parsed);
 *   if (!result.ok) throw new Error(result.violations.join("; "));
 *
 * 三处消费方（M4 末统一切到本类型）：
 *   1. evals/providers/sid-code-live.ts → wrapper 落 trace.json
 *   2. evals/providers/claude-code.ts → 同上
 *   3. scripts/eval/raw-jsonl-to-trace.ts → B6-6 转换器目标格式
 */

/** §2 顶层字段 */
export interface AgentTrace {
  trace_id: string;
  session_id: string;
  agent_kind: AgentKind;
  agent_version: string;
  case_id?: string;
  provider: string;
  model: string;
  started_at: string;
  ended_at: string;
  total_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  billable_tokens: number;
  status: TraceStatus;
  abnormal_reason?: string;
  final_output: string;
  spans: TraceSpan[];
}

/** 内置 agent kind；外部 agent 可使用任意非空字符串（运行时校验只检查非空） */
export const BUILTIN_AGENT_KINDS = ["sid-code", "claude-code", "claude-trace", "external"] as const;
export type AgentKind = string;
export type TraceStatus = "ok" | "abnormal" | "timeout" | "abort";

/** §2 span 字段 */
export interface TraceSpan {
  span_id: number;
  parent_span_id?: number;
  span_kind: SpanKind;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  role: SpanRole;
  agent_label: string;

  // action span 必填
  tool_name?: string;
  tool_input?: unknown;
  tool_input_brief?: string;

  // observation span 必填
  is_error?: boolean;
  tool_output?: string;
  tool_output_brief?: string;

  // thought span 可选
  thought?: string;

  // 通用
  tokens_input?: number;
  tokens_output?: number;
  metadata?: Record<string, unknown>;
}

export type SpanKind = "action" | "observation" | "thought" | "system" | "error";
export type SpanRole = "assistant" | "user" | "system";

/** schema 版本号（v2 对齐 OpenTelemetry GenAI 时升） */
export const TRACE_SCHEMA_VERSION = "v1";

/** §5 强约束：8KB 字段截断上限（trace_input / tool_output） */
export const SPAN_FIELD_BYTE_LIMIT = 8 * 1024;

/** UUID v4 正则（§5 第 1 条） */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ISO8601 with 时区正则（§5 第 3 条）：要求 Z 或 ±HH:MM 后缀 */
const ISO8601_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const VALID_AGENT_KINDS = BUILTIN_AGENT_KINDS as readonly string[];
const VALID_TRACE_STATUS: TraceStatus[] = ["ok", "abnormal", "timeout", "abort"];
const VALID_SPAN_KINDS: SpanKind[] = ["action", "observation", "thought", "system", "error"];
const VALID_SPAN_ROLES: SpanRole[] = ["assistant", "user", "system"];

export interface ValidationResult {
  ok: boolean;
  violations: string[];
}

/**
 * 校验 trace 对象是否满足 spec §5 的 5 条强约束（+ 顶层 / span 字段类型基础检查）。
 *
 * 返回 ok=true 表示该 trace 可被 evaluator 直接消费；
 * 返回 ok=false 时 violations 列出所有违反项（一次性给出，避免逐条 fix-test 循环）。
 *
 * 不做的事：
 * - 不校验语义合理性（如 total_duration_ms 必须 = ended_at - started_at），那是 evaluator 的事
 * - 不做字段补全 / 默认值填充，本函数纯只读
 */
export function validateTrace(input: unknown): ValidationResult {
  const violations: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, violations: ["trace must be a non-null object"] };
  }
  const t = input as Record<string, unknown>;

  // ===== 顶层必填字段类型检查 =====
  if (typeof t.trace_id !== "string") violations.push("trace_id must be string");
  if (typeof t.session_id !== "string") violations.push("session_id must be string");
  if (typeof t.agent_version !== "string") violations.push("agent_version must be string");
  if (typeof t.provider !== "string") violations.push("provider must be string");
  if (typeof t.model !== "string") violations.push("model must be string");
  if (typeof t.started_at !== "string") violations.push("started_at must be string");
  if (typeof t.ended_at !== "string") violations.push("ended_at must be string");
  if (typeof t.final_output !== "string") violations.push("final_output must be string");
  for (const k of [
    "total_duration_ms",
    "total_input_tokens",
    "total_output_tokens",
    "total_cache_read_tokens",
    "total_cache_creation_tokens",
    "billable_tokens",
  ]) {
    if (typeof t[k] !== "number") violations.push(`${k} must be number`);
  }

  // ===== 顶层枚举校验 =====
  if (typeof t.agent_kind !== "string" || t.agent_kind.length === 0) {
    violations.push(`agent_kind must be a non-empty string (builtin: ${VALID_AGENT_KINDS.join("/")})`);
  }
  if (!VALID_TRACE_STATUS.includes(t.status as TraceStatus)) {
    violations.push(`status must be one of ${VALID_TRACE_STATUS.join("/")}`);
  }

  // §5-1 trace_id / session_id 必须 UUID v4
  if (typeof t.trace_id === "string" && !UUID_V4_RE.test(t.trace_id)) {
    violations.push("§5-1: trace_id must be UUID v4");
  }
  if (typeof t.session_id === "string" && !UUID_V4_RE.test(t.session_id)) {
    violations.push("§5-1: session_id must be UUID v4");
  }

  // §5-3 timestamp 必须 ISO8601 with 时区
  if (typeof t.started_at === "string" && !ISO8601_TZ_RE.test(t.started_at)) {
    violations.push("§5-3: started_at must be ISO8601 with timezone");
  }
  if (typeof t.ended_at === "string" && !ISO8601_TZ_RE.test(t.ended_at)) {
    violations.push("§5-3: ended_at must be ISO8601 with timezone");
  }

  // §5-4 status=abnormal 时 abnormal_reason 必填
  if (t.status === "abnormal") {
    if (typeof t.abnormal_reason !== "string" || t.abnormal_reason.length === 0) {
      violations.push("§5-4: abnormal_reason must be non-empty when status=abnormal");
    }
  }

  // ===== spans 数组检查 =====
  if (!Array.isArray(t.spans)) {
    violations.push("spans must be array");
    return { ok: violations.length === 0, violations };
  }

  let prevEndedAt: number | null = null;
  for (let i = 0; i < t.spans.length; i++) {
    const s = t.spans[i] as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object") {
      violations.push(`spans[${i}] must be object`);
      continue;
    }

    if (typeof s.span_id !== "number") violations.push(`spans[${i}].span_id must be number`);
    if (!VALID_SPAN_KINDS.includes(s.span_kind as SpanKind)) {
      violations.push(`spans[${i}].span_kind must be one of ${VALID_SPAN_KINDS.join("/")}`);
    }
    if (!VALID_SPAN_ROLES.includes(s.role as SpanRole)) {
      violations.push(`spans[${i}].role must be one of ${VALID_SPAN_ROLES.join("/")}`);
    }

    // §5-3 span timestamp 必须 ISO8601 with 时区
    if (typeof s.started_at !== "string" || !ISO8601_TZ_RE.test(s.started_at as string)) {
      violations.push(`§5-3: spans[${i}].started_at must be ISO8601 with timezone`);
    }
    if (typeof s.ended_at !== "string" || !ISO8601_TZ_RE.test(s.ended_at as string)) {
      violations.push(`§5-3: spans[${i}].ended_at must be ISO8601 with timezone`);
    }

    // §5-2 tool_input / tool_output ≤ 8KB（截断需 metadata.truncated=true）
    if (s.tool_input !== undefined) {
      const serialized = typeof s.tool_input === "string" ? s.tool_input : JSON.stringify(s.tool_input);
      const bytes = Buffer.byteLength(serialized ?? "", "utf-8");
      const meta = (s.metadata ?? {}) as Record<string, unknown>;
      if (bytes > SPAN_FIELD_BYTE_LIMIT && meta.truncated !== true) {
        violations.push(
          `§5-2: spans[${i}].tool_input ${bytes}B > 8KB and metadata.truncated!=true`,
        );
      }
    }
    if (typeof s.tool_output === "string") {
      const bytes = Buffer.byteLength(s.tool_output, "utf-8");
      const meta = (s.metadata ?? {}) as Record<string, unknown>;
      if (bytes > SPAN_FIELD_BYTE_LIMIT && meta.truncated !== true) {
        violations.push(
          `§5-2: spans[${i}].tool_output ${bytes}B > 8KB and metadata.truncated!=true`,
        );
      }
    }

    // §5-5 spans 数组顺序 = 时间顺序
    if (typeof s.started_at === "string" && ISO8601_TZ_RE.test(s.started_at as string)) {
      const t0 = Date.parse(s.started_at as string);
      if (Number.isFinite(t0)) {
        if (prevEndedAt !== null && t0 < prevEndedAt) {
          violations.push(`§5-5: spans[${i}].started_at < spans[${i - 1}].ended_at（顺序乱）`);
        }
        const t1 = Date.parse((s.ended_at as string) ?? "");
        if (Number.isFinite(t1)) prevEndedAt = t1;
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/** 工具：截断 tool_input / tool_output 到 8KB，并打 metadata.truncated=true 标记。 */
export function truncateSpanField(value: string, byteLimit = SPAN_FIELD_BYTE_LIMIT): {
  value: string;
  truncated: boolean;
} {
  const buf = Buffer.from(value, "utf-8");
  if (buf.byteLength <= byteLimit) return { value, truncated: false };
  // 按字节截断后补尾标，spec §5-2 要求"无法对齐时按字节截断"
  const sliced = buf.subarray(0, byteLimit - Buffer.byteLength("... [truncated]", "utf-8"));
  return {
    value: sliced.toString("utf-8") + "... [truncated]",
    truncated: true,
  };
}
