/**
 * agent-trace v1 schema 单测（B6-5）
 *
 * 锁定 spec §5 的 5 条强约束，spec 改动 → 类型改动 → 本单测必须先红才能再绿。
 */

import { describe, test, expect } from "bun:test";
import {
  validateTrace,
  truncateSpanField,
  SPAN_FIELD_BYTE_LIMIT,
  TRACE_SCHEMA_VERSION,
  type AgentTrace,
} from "../../evals/_types/agent-trace.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function buildOk(overrides: Partial<AgentTrace> = {}): AgentTrace {
  return {
    trace_id: UUID_A,
    session_id: UUID_B,
    agent_kind: "sid-code",
    agent_version: "abc1234",
    case_id: "case_001",
    provider: "anthropic",
    model: "claude-opus-4-7",
    started_at: "2026-05-31T00:00:00Z",
    ended_at: "2026-05-31T00:00:30Z",
    total_duration_ms: 30_000,
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    billable_tokens: 150,
    status: "ok",
    final_output: "done",
    spans: [
      {
        span_id: 0,
        span_kind: "action",
        started_at: "2026-05-31T00:00:01Z",
        ended_at: "2026-05-31T00:00:02Z",
        duration_ms: 1000,
        role: "assistant",
        agent_label: "primary",
        tool_name: "Read",
        tool_input: { file_path: "/x" },
      },
      {
        span_id: 1,
        span_kind: "observation",
        started_at: "2026-05-31T00:00:02Z",
        ended_at: "2026-05-31T00:00:03Z",
        duration_ms: 1000,
        role: "system",
        agent_label: "primary",
        tool_output: "ok",
      },
    ],
    ...overrides,
  };
}

describe("validateTrace - 顶层 happy path", () => {
  test("规范 trace → ok=true，violations 空", () => {
    const r = validateTrace(buildOk());
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("non-object 输入 → ok=false", () => {
    expect(validateTrace(null).ok).toBe(false);
    expect(validateTrace("text").ok).toBe(false);
    expect(validateTrace([]).ok).toBe(false);
  });

  test("缺顶层必填字段 → 有违反", () => {
    const t = buildOk();
    const broken: Record<string, unknown> = { ...t };
    delete broken.provider;
    const r = validateTrace(broken);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("provider"))).toBe(true);
  });
});

describe("validateTrace §5-1 trace_id / session_id 必须 UUID v4", () => {
  test("非 UUID 格式 → 违反", () => {
    const r = validateTrace(buildOk({ trace_id: "abc" }));
    expect(r.violations.some((v) => v.includes("§5-1: trace_id"))).toBe(true);
  });

  test("session_id 非 UUID → 违反", () => {
    const r = validateTrace(buildOk({ session_id: "1234567890" }));
    expect(r.violations.some((v) => v.includes("§5-1: session_id"))).toBe(true);
  });

  test("UUID v3（非 v4）→ 违反", () => {
    const r = validateTrace(buildOk({ trace_id: "11111111-1111-3111-8111-111111111111" }));
    expect(r.violations.some((v) => v.includes("§5-1: trace_id"))).toBe(true);
  });
});

describe("validateTrace §5-2 tool_input / tool_output 8KB 截断", () => {
  test("tool_input 超 8KB 且 metadata.truncated=true → 不报", () => {
    const t = buildOk();
    t.spans[0].tool_input = "x".repeat(SPAN_FIELD_BYTE_LIMIT + 100);
    t.spans[0].metadata = { truncated: true };
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("§5-2"))).toBe(false);
  });

  test("tool_input 超 8KB 且无 truncated 标记 → 违反", () => {
    const t = buildOk();
    t.spans[0].tool_input = "x".repeat(SPAN_FIELD_BYTE_LIMIT + 100);
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("§5-2") && v.includes("tool_input"))).toBe(true);
  });

  test("tool_output 超 8KB 且无 truncated → 违反", () => {
    const t = buildOk();
    t.spans[1].tool_output = "y".repeat(SPAN_FIELD_BYTE_LIMIT + 100);
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("§5-2") && v.includes("tool_output"))).toBe(true);
  });

  test("tool_input 8KB 边界刚好 → 不报", () => {
    const t = buildOk();
    t.spans[0].tool_input = "x".repeat(SPAN_FIELD_BYTE_LIMIT);
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("§5-2"))).toBe(false);
  });
});

describe("validateTrace §5-3 timestamp 必须 ISO8601 with 时区", () => {
  test("epoch 数字 → 违反", () => {
    const t = buildOk();
    (t as unknown as Record<string, unknown>).started_at = 1748736000000 as unknown as string;
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("started_at must be string"))).toBe(true);
  });

  test("缺时区后缀 → 违反 §5-3", () => {
    const r = validateTrace(buildOk({ started_at: "2026-05-31T00:00:00" }));
    expect(r.violations.some((v) => v.includes("§5-3"))).toBe(true);
  });

  test("+08:00 时区合法", () => {
    const r = validateTrace(buildOk({ started_at: "2026-05-31T08:00:00+08:00" }));
    expect(r.ok).toBe(true);
  });

  test("span 时间戳缺时区 → 违反", () => {
    const t = buildOk();
    t.spans[0].started_at = "2026-05-31T00:00:01";
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("§5-3") && v.includes("spans[0]"))).toBe(true);
  });
});

describe("validateTrace §5-4 status=abnormal 时 abnormal_reason 必填", () => {
  test("status=abnormal 且 abnormal_reason 缺失 → 违反", () => {
    const r = validateTrace(buildOk({ status: "abnormal" }));
    expect(r.violations.some((v) => v.includes("§5-4"))).toBe(true);
  });

  test("status=abnormal + abnormal_reason 非空 → 不报", () => {
    const r = validateTrace(buildOk({ status: "abnormal", abnormal_reason: "tool_call_loop" }));
    expect(r.violations.some((v) => v.includes("§5-4"))).toBe(false);
  });

  test("status=ok 时 abnormal_reason 非必填", () => {
    const r = validateTrace(buildOk({ status: "ok" }));
    expect(r.violations.some((v) => v.includes("§5-4"))).toBe(false);
  });
});

describe("validateTrace §5-5 spans 数组顺序 = 时间顺序", () => {
  test("正序 → 不报", () => {
    const r = validateTrace(buildOk());
    expect(r.violations.some((v) => v.includes("§5-5"))).toBe(false);
  });

  test("第二个 span started_at 早于第一个 ended_at → 违反", () => {
    const t = buildOk();
    t.spans[1].started_at = "2026-05-31T00:00:01.500Z"; // 早于 spans[0].ended_at = 00:00:02Z
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("§5-5"))).toBe(true);
  });
});

describe("validateTrace 枚举校验", () => {
  test("agent_kind 空字符串 → 违反", () => {
    const r = validateTrace(buildOk({ agent_kind: "" as never }));
    expect(r.violations.some((v) => v.includes("agent_kind"))).toBe(true);
  });

  test("agent_kind 任意非空字符串 → 合法（可扩展）", () => {
    const r = validateTrace(buildOk({ agent_kind: "custom-agent" as never }));
    expect(r.violations.some((v) => v.includes("agent_kind"))).toBe(false);
  });

  test("status 非法 → 违反", () => {
    const r = validateTrace(buildOk({ status: "weird" as never }));
    expect(r.violations.some((v) => v.includes("status"))).toBe(true);
  });

  test("span_kind 非法 → 违反", () => {
    const t = buildOk();
    t.spans[0].span_kind = "unknown" as never;
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("span_kind"))).toBe(true);
  });

  test("role 非法 → 违反", () => {
    const t = buildOk();
    t.spans[0].role = "robot" as never;
    const r = validateTrace(t);
    expect(r.violations.some((v) => v.includes("role"))).toBe(true);
  });
});

describe("truncateSpanField - 8KB 截断辅助", () => {
  test("短串不截", () => {
    const r = truncateSpanField("hello");
    expect(r.truncated).toBe(false);
    expect(r.value).toBe("hello");
  });

  test("超长串截断 + 补尾标", () => {
    const r = truncateSpanField("x".repeat(SPAN_FIELD_BYTE_LIMIT + 100));
    expect(r.truncated).toBe(true);
    expect(r.value.endsWith("... [truncated]")).toBe(true);
    expect(Buffer.byteLength(r.value, "utf-8")).toBeLessThanOrEqual(SPAN_FIELD_BYTE_LIMIT);
  });

  test("自定义 byteLimit 生效", () => {
    const r = truncateSpanField("x".repeat(100), 50);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.value, "utf-8")).toBeLessThanOrEqual(50);
  });
});

describe("schema 版本号常量", () => {
  test("当前 schema 版本号 = v1", () => {
    expect(TRACE_SCHEMA_VERSION).toBe("v1");
  });
});
