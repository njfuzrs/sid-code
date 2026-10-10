// src/telemetry/perfetto.ts
// Perfetto 格式追踪——本地性能分析
//
// 对应 spec 17 §6.2。
// 将 SpanData 转换为 Perfetto Trace Event 格式,可在 chrome://tracing
// 或 https://ui.perfetto.dev 中可视化。
// 注意:适配实际 SpanData 字段(kind / durationMs),而非 spec 草案的 operationName / duration。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sidPaths } from "../config/paths.ts";
import type { SpanData } from "./types.ts";

interface PerfettoEvent {
  name: string;
  cat: string; // 分类
  ph: string; // 阶段:B(begin), E(end), X(complete)
  ts: number; // 微秒时间戳
  dur?: number; // 持续时间(微秒)
  pid: number; // 进程 ID
  tid: number; // 线程 ID(用 span 类型区分)
  args?: Record<string, unknown>;
}

/** span kind → Perfetto tid(同类 Span 在同一"线程"泳道) */
const TID_MAP: Record<string, number> = {
  invoke_agent: 1,
  chat: 2,
  execute_tool: 3,
  // 预留：这两类 span 当前恒不产生（见 types.ts SpanKind 注释），tid 4/5 的轨道恒空
  blocked_on_user: 4,
  hook_execution: 5,
};

/** 是否启用 Perfetto 追踪 */
export function isPerfettoEnabled(): boolean {
  return !!process.env.SID_CODE_PERFETTO_TRACE;
}

/** 将 Span 数据转换为 Perfetto 事件 */
export function spanToPerfettoEvent(span: SpanData): PerfettoEvent {
  return {
    name: span.name,
    cat: span.kind,
    ph: "X", // Complete event
    ts: span.startTime * 1000, // ms → μs
    dur: span.durationMs ? span.durationMs * 1000 : 0,
    pid: process.pid,
    tid: TID_MAP[span.kind] ?? 0,
    args: {
      ...span.attributes,
      trace_id: span.traceId,
      span_id: span.spanId,
      ...(span.parentSpanId ? { parent_span_id: span.parentSpanId } : {}),
      status: span.status,
    },
  };
}

/** Perfetto / Chrome trace 的 JSON Object 格式；`otherData` 是格式允许的自由元数据区 */
export interface PerfettoTrace {
  traceEvents: PerfettoEvent[];
  otherData?: Record<string, unknown>;
}

/**
 * 构建完整的 Perfetto trace 对象。
 *
 * `evictedSpans`：spanHistory 因 500 上限挤掉的条数（缺陷 38）。被挤掉的恰是最旧的
 * `invoke_agent` 根，UI 里只剩互不相连的浮空条而文件完全合法 —— 所以截断必须写进文件本身，
 * 读图的人才知道「这不是全貌」。
 */
export function buildPerfettoTrace(spans: SpanData[], evictedSpans = 0): PerfettoTrace {
  const trace: PerfettoTrace = { traceEvents: spans.map(spanToPerfettoEvent) };
  if (evictedSpans > 0) {
    trace.otherData = {
      sid_code_truncated: true,
      sid_code_evicted_spans: evictedSpans,
      note: `最早的 ${evictedSpans} 条 span（含根）已因会话内 history 上限被淘汰，嵌套关系不完整`,
    };
  }
  return trace;
}

/**
 * 默认落盘路径：`~/.sid-code/telemetry/perfetto/`。
 *
 * 缺陷 38：曾是相对路径 `sid-code-trace-<ts>.json`，即落在 `process.cwd()` —— 用户仓库根，
 * 不在 .gitignore 里、文件名带时间戳只增不覆盖，开几次追踪 `git status` 就脏了。
 * 本仓其余落盘一律走 sidPaths。显式给路径（`SID_CODE_PERFETTO_TRACE=<path>`）仍按用户意图写。
 */
export function defaultPerfettoPath(now = Date.now()): string {
  return join(sidPaths.telemetry(), "perfetto", `sid-code-trace-${now}.json`);
}

/** 将所有 Span 写入 Perfetto 追踪文件 */
export function writePerfettoTrace(
  spans: SpanData[],
  outputPath?: string,
  evictedSpans = 0,
): string | null {
  if (spans.length === 0) return null;
  const trace = buildPerfettoTrace(spans, evictedSpans);

  const envPath = process.env.SID_CODE_PERFETTO_TRACE;
  // 环境变量为 "1" 时视为开关而非路径,使用默认文件名
  const path = outputPath ?? (envPath && envPath !== "1" ? envPath : defaultPerfettoPath());

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(trace), "utf-8");
    return path;
  } catch {
    return null;
  }
}
