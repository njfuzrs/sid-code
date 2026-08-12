// src/telemetry/perfetto.ts
// Perfetto 格式追踪——本地性能分析
//
// 对应 spec 17 §6.2。
// 将 SpanData 转换为 Perfetto Trace Event 格式,可在 chrome://tracing
// 或 https://ui.perfetto.dev 中可视化。
// 注意:适配实际 SpanData 字段(kind / durationMs),而非 spec 草案的 operationName / duration。

import { writeFileSync } from "node:fs";
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

/** 构建完整的 Perfetto trace 对象 */
export function buildPerfettoTrace(spans: SpanData[]): { traceEvents: PerfettoEvent[] } {
  return { traceEvents: spans.map(spanToPerfettoEvent) };
}

/** 将所有 Span 写入 Perfetto 追踪文件 */
export function writePerfettoTrace(spans: SpanData[], outputPath?: string): string | null {
  if (spans.length === 0) return null;
  const trace = buildPerfettoTrace(spans);

  const envPath = process.env.SID_CODE_PERFETTO_TRACE;
  // 环境变量为 "1" 时视为开关而非路径,使用默认文件名
  const path =
    outputPath ?? (envPath && envPath !== "1" ? envPath : `sid-code-trace-${Date.now()}.json`);

  try {
    writeFileSync(path, JSON.stringify(trace), "utf-8");
    return path;
  } catch {
    return null;
  }
}
