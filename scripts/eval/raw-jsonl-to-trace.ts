#!/usr/bin/env bun
/**
 * raw-jsonl-to-trace.ts —— B6-6 raw.jsonl → trace.jsonl 转换器
 *
 * spec：`docs/eval/specs/trace-schema-v1.md` §4 兼容矩阵第 2 条
 * 类型：`evals/_types/agent-trace.ts`（spec §2 的 TS 类型 + §5 校验）
 *
 * 转换策略：
 *   raw.jsonl 每行 = 1 个 API call（request/response 对）；converter 把每行展开为多个 span：
 *     1. response.content[].type=tool_use → 1 个 action span（tool_name + tool_input）
 *     2. response.content[].type=text     → 1 个 thought span（assistant 文本输出）
 *     3. request.messages[末尾 user].content[].type=tool_result → 1 个 observation span（is_error + tool_output）
 *
 *   span_id：单调递增，0-based；observation span 的 parent_span_id 留空（v1 不强求 tool_use_id 反查）
 *   时间戳：raw.jsonl 给的是 timestamp（API call 发起时间），转 ISO8601 with Z 后缀；ended_at 用 timestamp + 1ms 兜底（API 协议层无 duration_ms 信息）
 *   usage：累加每行 raw 的 input_tokens / output_tokens / cache_*，落顶层 total_*
 *
 * 信息损失（spec §4 已说明）：
 *   - tool_call_loop / abort 等业务级 abnormal_reason 推不出来 → status 默认 "ok"，由调用方 override
 *   - sub-agent 嵌套 → API 协议层不可见，agent_label 一律 "primary"
 *   - parent_span_id → tool_result 与上一条 tool_use 的关联只能用 tool_use_id 匹配，v1 暂不连，metadata.tool_use_id 留作未来用
 *
 * 用法：
 *   bun run scripts/eval/raw-jsonl-to-trace.ts \
 *     <raw.jsonl 路径> [trace.json 输出路径]
 *
 * 退出码：
 *   0 = 转换成功
 *   1 = 校验失败（spec §5 强约束违反）
 *   2 = 用法错误 / 文件不存在
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import {
  validateTrace,
  truncateSpanField,
  SPAN_FIELD_BYTE_LIMIT,
  type AgentTrace,
  type TraceSpan,
} from "../../evals/framework/trace/agent-trace.ts";

interface RawLine {
  timestamp?: string;
  index?: number;
  model?: string;
  request?: {
    model?: string;
    messages?: Array<{
      role?: string;
      content?: unknown;
    }>;
  };
  response?: {
    content?: Array<Record<string, unknown>>;
    stop_reason?: string;
    role?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
  is_partial?: boolean;
}

export interface ConvertOptions {
  /** session UUID（v4），通常从 raw.jsonl 父目录提取；缺失时报错 */
  session_id: string;
  /** 评测 case_id，可选；dogfood 转换不填 */
  case_id?: string;
  /** agent_kind 默认 "claude-trace"（claude-trace SDK 抓的） */
  agent_kind?: AgentTrace["agent_kind"];
  /** agent_version：commit hash 或版本号 */
  agent_version?: string;
  /** provider 默认 "anthropic" */
  provider?: string;
  /** trace_id：默认重用 session_id */
  trace_id?: string;
}

/**
 * 把 utf-8 字符串转 ISO8601 with timezone（Z 后缀）。
 * raw.jsonl 的 timestamp 形如 "2026-03-26T10:54:34.147888"（无时区），按 UTC 解读。
 */
function toIsoUtc(ts: string | undefined, fallback: string): string {
  if (!ts || typeof ts !== "string") return fallback;
  // 已含时区后缀（Z 或 ±HH:MM）→ 原样返回
  if (/Z$|[+-]\d{2}:\d{2}$/.test(ts)) return ts;
  // 否则按 UTC 拼 Z
  return `${ts}Z`;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushTruncatedField(
  span: TraceSpan,
  field: "tool_input" | "tool_output",
  rawValue: unknown,
): void {
  const serialized = safeStringify(rawValue);
  if (Buffer.byteLength(serialized, "utf-8") <= SPAN_FIELD_BYTE_LIMIT) {
    if (field === "tool_input") {
      span.tool_input = rawValue;
      span.tool_input_brief = serialized.slice(0, 200);
    } else {
      span.tool_output = serialized;
      span.tool_output_brief = serialized.slice(0, 200);
    }
    return;
  }

  // 超 8KB → 截断 + metadata.truncated=true
  const { value: truncated } = truncateSpanField(serialized);
  if (field === "tool_input") {
    span.tool_input = truncated;
    span.tool_input_brief = truncated.slice(0, 200);
  } else {
    span.tool_output = truncated;
    span.tool_output_brief = truncated.slice(0, 200);
  }
  span.metadata = { ...(span.metadata ?? {}), truncated: true };
}

/** 从 request.messages 末尾的 user tool_result 提取 observation spans */
function extractObservationSpansFromMessages(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
  baseTimestamp: string,
  startSpanId: number,
): TraceSpan[] {
  const spans: TraceSpan[] = [];
  if (!Array.isArray(messages)) return spans;

  // 只看末尾的 user message（前面的 user message 都已转成过 observation span）
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!m || m.role !== "user") {
      // 遇到 assistant，停止（更早的 user message 是历史，不重复转）
      if (m?.role === "assistant") break;
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    for (const c of m.content) {
      if (!c || typeof c !== "object") continue;
      const block = c as Record<string, unknown>;
      if (block.type !== "tool_result") continue;

      const span: TraceSpan = {
        span_id: startSpanId + spans.length,
        span_kind: "observation",
        started_at: baseTimestamp,
        ended_at: baseTimestamp,
        duration_ms: 0,
        role: "system",
        agent_label: "primary",
        is_error: block.is_error === true,
        metadata: typeof block.tool_use_id === "string" ? { tool_use_id: block.tool_use_id } : undefined,
      };

      // tool_result.content 可能是 string 或 array<{type:"text"|"image", text?}>
      const out = block.content;
      if (typeof out === "string") {
        pushTruncatedField(span, "tool_output", out);
      } else if (Array.isArray(out)) {
        const flattened = out
          .map((p) => {
            if (typeof p === "string") return p;
            if (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string") {
              return (p as Record<string, unknown>).text as string;
            }
            return "";
          })
          .filter((s) => s.length > 0)
          .join("\n");
        if (flattened.length > 0) pushTruncatedField(span, "tool_output", flattened);
      }

      if (span.is_error) span.span_kind = "error";
      spans.push(span);
    }
    break; // 只处理末尾的 user message
  }

  return spans;
}

/** 从 response.content 提取 action / thought spans */
function extractActionSpansFromResponse(
  content: unknown,
  baseTimestamp: string,
  startSpanId: number,
  usageThisLine: { input_tokens: number; output_tokens: number },
): TraceSpan[] {
  const spans: TraceSpan[] = [];
  if (!Array.isArray(content)) return spans;

  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as Record<string, unknown>;
    const type = block.type;

    if (type === "tool_use") {
      const span: TraceSpan = {
        span_id: startSpanId + spans.length,
        span_kind: "action",
        started_at: baseTimestamp,
        ended_at: baseTimestamp,
        duration_ms: 0,
        role: "assistant",
        agent_label: "primary",
        tool_name: typeof block.name === "string" ? block.name : "unknown",
        tokens_output: usageThisLine.output_tokens,
        metadata: typeof block.id === "string" ? { tool_use_id: block.id } : undefined,
      };
      pushTruncatedField(span, "tool_input", block.input ?? {});
      spans.push(span);
    } else if (type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text.trim().length === 0) continue;
      const span: TraceSpan = {
        span_id: startSpanId + spans.length,
        span_kind: "thought",
        started_at: baseTimestamp,
        ended_at: baseTimestamp,
        duration_ms: 0,
        role: "assistant",
        agent_label: "primary",
        thought: text.length > SPAN_FIELD_BYTE_LIMIT ? truncateSpanField(text).value : text,
        tokens_output: usageThisLine.output_tokens,
      };
      if (text.length > SPAN_FIELD_BYTE_LIMIT) {
        span.metadata = { truncated: true };
      }
      spans.push(span);
    }
  }

  return spans;
}

/** raw.jsonl → AgentTrace 主转换 */
export function convertRawJsonlToTrace(rawText: string, opts: ConvertOptions): AgentTrace {
  const lines = rawText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("raw.jsonl is empty");
  }

  const parsedLines: RawLine[] = lines
    .map((l, idx) => {
      try {
        return JSON.parse(l) as RawLine;
      } catch (e) {
        throw new Error(`raw.jsonl line ${idx + 1} JSON parse fail: ${(e as Error).message}`);
      }
    })
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const firstTs = toIsoUtc(parsedLines[0]?.timestamp, "1970-01-01T00:00:00Z");
  const lastTs = toIsoUtc(parsedLines[parsedLines.length - 1]?.timestamp, firstTs);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  const spans: TraceSpan[] = [];
  let lastFinalText = "";

  for (const line of parsedLines) {
    const ts = toIsoUtc(line.timestamp, firstTs);
    const u = line.usage ?? {};
    const inT = typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const outT = typeof u.output_tokens === "number" ? u.output_tokens : 0;
    const ccT = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
    const crT = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
    totalInput += inT;
    totalOutput += outT;
    totalCacheRead += crT;
    totalCacheCreation += ccT;

    // 1. 先抽 observation（来自 request.messages 末尾的 user tool_result，这是"上一轮 action 的观察"）
    spans.push(...extractObservationSpansFromMessages(line.request?.messages, ts, spans.length));

    // 2. 再抽 action / thought（来自 response.content）
    const actionSpans = extractActionSpansFromResponse(
      line.response?.content,
      ts,
      spans.length,
      { input_tokens: inT, output_tokens: outT },
    );
    spans.push(...actionSpans);

    // final_output 用最后一行 response.content 里所有 text 块拼接
    const responseContent = line.response?.content;
    if (Array.isArray(responseContent)) {
      const texts = responseContent
        .filter((c) => c && typeof c === "object" && (c as Record<string, unknown>).type === "text")
        .map((c) => (c as Record<string, unknown>).text)
        .filter((t) => typeof t === "string");
      if (texts.length > 0) lastFinalText = texts.join("\n");
    }
  }

  // billable_tokens 公式与 eval-judge.ts gradeCost 对齐：input + output + cache_creation + cache_read × 0.1
  const billable = totalInput + totalOutput + totalCacheCreation + Math.round(totalCacheRead * 0.1);

  const trace: AgentTrace = {
    trace_id: opts.trace_id ?? opts.session_id,
    session_id: opts.session_id,
    agent_kind: opts.agent_kind ?? "claude-trace",
    agent_version: opts.agent_version ?? "unknown",
    case_id: opts.case_id,
    provider: opts.provider ?? "anthropic",
    model: parsedLines[0]?.model ?? parsedLines[0]?.request?.model ?? "unknown",
    started_at: firstTs,
    ended_at: lastTs,
    total_duration_ms: Math.max(0, Date.parse(lastTs) - Date.parse(firstTs)),
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_read_tokens: totalCacheRead,
    total_cache_creation_tokens: totalCacheCreation,
    billable_tokens: billable,
    status: "ok",
    final_output: lastFinalText,
    spans,
  };

  return trace;
}

/** UUID v4 正则（与 agent-trace.ts 同口径，仅做 sid 提取时校验） */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 从 raw.jsonl 路径提取 session UUID（claude-trace 默认目录结构 sessions/<sid>/raw.jsonl） */
export function extractSessionIdFromPath(path: string): string | null {
  const m = path.match(/sessions\/([0-9a-f-]{36})\//i);
  if (!m) return null;
  if (!UUID_V4_RE.test(m[1])) return null;
  return m[1];
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length < 1) {
    console.error("usage: bun run scripts/eval/raw-jsonl-to-trace.ts <raw.jsonl> [trace.json]");
    return 2;
  }

  const rawPath = resolve(args[0]);
  if (!existsSync(rawPath) || !statSync(rawPath).isFile()) {
    console.error(`[converter] ❌ raw.jsonl not found: ${rawPath}`);
    return 2;
  }

  const sid = extractSessionIdFromPath(rawPath);
  if (!sid) {
    console.error(
      `[converter] ❌ cannot extract session UUID v4 from path; expect "sessions/<uuid>/raw.jsonl"\n   got: ${rawPath}`,
    );
    return 2;
  }

  const rawText = readFileSync(rawPath, "utf-8");
  let trace: AgentTrace;
  try {
    trace = convertRawJsonlToTrace(rawText, { session_id: sid });
  } catch (e) {
    console.error(`[converter] ❌ convert fail: ${(e as Error).message}`);
    return 1;
  }

  const result = validateTrace(trace);
  if (!result.ok) {
    console.error("[converter] ❌ schema validation failed:");
    for (const v of result.violations) console.error(`  - ${v}`);
    return 1;
  }

  // 输出路径：默认 raw.jsonl 同目录 trace.json
  const outPath = args[1] ? resolve(args[1]) : resolve(dirname(rawPath), "trace.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(trace, null, 2), "utf-8");
  console.log(
    `[converter] ✅ ${basename(rawPath)} → ${outPath}  spans=${trace.spans.length}  billable=${trace.billable_tokens}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}

export { main };
