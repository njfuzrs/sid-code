#!/usr/bin/env bun
/**
 * parse-incident-log.ts — incident-rca Skill 日志解析脚本
 *
 * 输入: 结构化或非结构化日志文本（stdin 或 --file <path>）
 * 输出: 结构化 JSON
 *   {
 *     entries: [{ timestamp, level, service, message, trace_id?, span_id?, error_class? }],
 *     timeline: [{ timestamp, event, severity }],
 *     summary: { total_entries, error_count, warn_count, services_involved, time_range_ms }
 *   }
 *
 * 支持格式:
 *   - JSON lines (structured logging)
 *   - 常见 timestamp + level + message 格式
 *   - K8s pod log 格式
 *
 * RFC-004 §2.1 / SKILL.md §3.1 / S8-T11 Step 4 实施.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface LogEntry {
  timestamp: string;
  level: "error" | "warn" | "info" | "debug" | "unknown";
  service: string;
  message: string;
  trace_id?: string;
  span_id?: string;
  error_class?: string;
}

export interface TimelineEvent {
  timestamp: string;
  event: string;
  severity: "critical" | "high" | "medium" | "low";
}

export interface ParsedIncidentLog {
  entries: LogEntry[];
  timeline: TimelineEvent[];
  summary: {
    total_entries: number;
    error_count: number;
    warn_count: number;
    services_involved: string[];
    time_range_ms: number;
  };
}

const LEVEL_MAP: Record<string, LogEntry["level"]> = {
  error: "error", err: "error", fatal: "error", panic: "error", critical: "error",
  warn: "warn", warning: "warn",
  info: "info", notice: "info",
  debug: "debug", trace: "debug",
};

const TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const LEVEL_RE = /\b(ERROR|WARN|INFO|DEBUG|FATAL|PANIC|CRITICAL|WARNING|NOTICE|TRACE)\b/i;
const SERVICE_RE = /\[([a-zA-Z0-9_\-./]+)\]/;
const TRACE_ID_RE = /trace[_-]?id[=: ]+([a-f0-9\-]{16,36})/i;
const SPAN_ID_RE = /span[_-]?id[=: ]+([a-f0-9\-]{8,16})/i;
const ERROR_CLASS_RE = /(?:Error|Exception|Panic|Fault):\s*([^\n]{1,80})/;

function parseJsonLine(line: string): LogEntry | null {
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const ts = (j.timestamp ?? j.ts ?? j.time ?? j["@timestamp"] ?? "") as string;
    const lvl = String(j.level ?? j.severity ?? j.lvl ?? "info").toLowerCase();
    return {
      timestamp: ts,
      level: LEVEL_MAP[lvl] ?? "unknown",
      service: String(j.service ?? j.logger ?? j.component ?? "unknown"),
      message: String(j.message ?? j.msg ?? j.text ?? ""),
      trace_id: (j.trace_id ?? j.traceId) as string | undefined,
      span_id: (j.span_id ?? j.spanId) as string | undefined,
      error_class: (j.error_class ?? j.error_type) as string | undefined,
    };
  } catch {
    return null;
  }
}

function parseTextLine(line: string): LogEntry {
  const tsMatch = line.match(TIMESTAMP_RE);
  const lvlMatch = line.match(LEVEL_RE);
  const svcMatch = line.match(SERVICE_RE);
  const traceMatch = line.match(TRACE_ID_RE);
  const spanMatch = line.match(SPAN_ID_RE);
  const errMatch = line.match(ERROR_CLASS_RE);

  const lvlStr = (lvlMatch?.[1] ?? "info").toLowerCase();

  return {
    timestamp: tsMatch?.[1] ?? "",
    level: LEVEL_MAP[lvlStr] ?? "unknown",
    service: svcMatch?.[1] ?? "unknown",
    message: line.slice(0, 200),
    trace_id: traceMatch?.[1],
    span_id: spanMatch?.[1],
    error_class: errMatch?.[1],
  };
}

function toMs(ts: string): number {
  try { return new Date(ts).getTime(); } catch { return 0; }
}

export function parseIncidentLog(content: string): ParsedIncidentLog {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    const jsonEntry = parseJsonLine(line);
    if (jsonEntry) {
      entries.push(jsonEntry);
    } else {
      entries.push(parseTextLine(line));
    }
  }

  const errors = entries.filter((e) => e.level === "error");
  const warns = entries.filter((e) => e.level === "warn");
  const services = [...new Set(entries.map((e) => e.service).filter((s) => s !== "unknown"))];

  const timestamps = entries.map((e) => toMs(e.timestamp)).filter((t) => t > 0);
  const timeRange = timestamps.length >= 2
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0;

  // 构建 timeline（仅 error + 首个 warn）
  const timeline: TimelineEvent[] = errors.slice(0, 10).map((e) => ({
    timestamp: e.timestamp,
    event: e.error_class ?? e.message.slice(0, 80),
    severity: "critical" as const,
  }));

  if (warns.length > 0 && timeline.length < 15) {
    timeline.push(...warns.slice(0, 5).map((e) => ({
      timestamp: e.timestamp,
      event: e.message.slice(0, 80),
      severity: "medium" as const,
    })));
  }

  timeline.sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));

  return {
    entries,
    timeline,
    summary: {
      total_entries: entries.length,
      error_count: errors.length,
      warn_count: warns.length,
      services_involved: services,
      time_range_ms: timeRange,
    },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { file: { type: "string" } }, allowPositionals: false });
  const content = values.file ? readFileSync(values.file, "utf-8") : readFileSync(0, "utf-8");
  const r = parseIncidentLog(content);
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
