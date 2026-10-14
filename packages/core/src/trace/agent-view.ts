// src/trace/agent-view.ts
//
// E1（2026-10-14）：「父会话 → 子代理 → 每轮请求」的单子代理视图。
//
// ── 为什么需要 ─────────────────────────────────────────────────────────
// 子代理遥测刻意留在父会话的 events.jsonl（成本账本 / northstar / digest 都按会话聚合，
// 拆出去子代理花费会从「单位任务成本」里漏掉——见 .agents/notes rejected 那份）。
// 代价是一个子代理的事件散在几千行父会话事件里。事故 20261014-110202 排查时
// 只能按时间戳人肉拼，因为同一个子代理有三种 id。规范 id 统一之后，按 id 一次过滤即可。
//
// 匹配口径：
//   · 事件的 `agent_id`（StreamPhase / BilledRequest / SubagentStart/Stop）或
//     `agentId`（RetryTelemetry）等于查询 id；
//   · 或 `legacy_agent_id` 等于查询 id（过渡期：用户手里可能是旧形态）；
//   · 查询值也可以只给 taskId 后缀（`aoiyka2wx`）——按 `-sub-<taskId>` / `-<taskId>` 结尾匹配，
//     报错文本里最常见的就是这个短号。
// 父链路：SubagentStart.parent_tool_use_id → 父会话 PreToolUse(sub_agent).tool_use_id。
// 2026-10-14 之前的轨迹没有这个字段，视图会如实标「无 parent_tool_use_id（旧轨迹）」，不靠时间戳猜。

import { existsSync, readFileSync } from "node:fs";

interface RawEvent {
  event?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface AgentViewRequest {
  event: string;
  timestamp?: string;
  /** 精简字段：phase / type / model / tokens 等，按事件类型挑 */
  summary: Record<string, unknown>;
}

export interface AgentView {
  query: string;
  /** 实际命中的规范 id（可能与 query 不同：query 只给了 taskId 后缀时） */
  agentIds: string[];
  start?: Record<string, unknown>;
  stop?: Record<string, unknown>;
  /** 父会话里派发它的那次工具调用（按 parent_tool_use_id 精确匹配；旧轨迹为 undefined） */
  parentToolCall?: { tool_use_id: string; timestamp?: string };
  /** 该子代理的全部遥测事件（StreamPhase / RetryTelemetry / BilledRequest …），按时间序 */
  requests: AgentViewRequest[];
  /** 计数：按事件类型 */
  counts: Record<string, number>;
}

function eventAgentIds(d: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["agent_id", "agentId", "legacy_agent_id"]) {
    const v = d[k];
    if (typeof v === "string" && v) out.push(v);
  }
  return out;
}

function matches(id: string, query: string): boolean {
  return id === query || id.endsWith(`-sub-${query}`) || id.endsWith(`-${query}`);
}

const SUMMARY_KEYS = [
  "phase",
  "type",
  "index",
  "attempt",
  "model",
  "ttft_ms",
  "ttfb_ms",
  "elapsedMs",
  "delayMs",
  "giveUpReason",
  "reopenReason",
  "sleptMs",
  "family",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "error",
];

function summarize(d: Record<string, unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const k of SUMMARY_KEYS) if (d[k] !== undefined && d[k] !== null) s[k] = d[k];
  return s;
}

/** 从父会话 events.jsonl 抽出单个子代理的视图。文件不存在或无命中时 agentIds 为空。 */
export function buildAgentView(eventsPath: string, query: string): AgentView {
  const view: AgentView = { query, agentIds: [], requests: [], counts: {} };
  if (!existsSync(eventsPath)) return view;

  const events: RawEvent[] = [];
  for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RawEvent);
    } catch {
      /* 半行（进程被杀时的尾行）跳过 */
    }
  }

  const ids = new Set<string>();
  const preToolUse = new Map<string, string | undefined>();
  for (const e of events) {
    const d = e.data ?? {};
    if (
      e.event === "PreToolUse" &&
      d.tool_name === "sub_agent" &&
      typeof d.tool_use_id === "string"
    ) {
      preToolUse.set(d.tool_use_id, e.timestamp);
    }
    const own = eventAgentIds(d);
    if (!own.some((id) => matches(id, query))) continue;
    // 只收录规范形态 / 主 id（legacy 值不进 agentIds，避免同一个子代理报两个 id）
    const primary = (d.agent_id ?? d.agentId) as string | undefined;
    if (primary) ids.add(primary);

    const name = e.event ?? "?";
    view.counts[name] = (view.counts[name] ?? 0) + 1;
    if (name === "SubagentStart") view.start = d;
    else if (name === "SubagentStop") view.stop = d;
    else view.requests.push({ event: name, timestamp: e.timestamp, summary: summarize(d) });
  }
  view.agentIds = [...ids];

  const ptu = view.start?.parent_tool_use_id;
  if (typeof ptu === "string" && ptu) {
    view.parentToolCall = { tool_use_id: ptu, timestamp: preToolUse.get(ptu) };
  }
  return view;
}

/** 人读渲染：一屏看完「父调用 → 起止 → 每条请求」。 */
export function renderAgentView(v: AgentView): string {
  if (v.agentIds.length === 0) {
    return `未在该会话中找到子代理 "${v.query}"（支持规范 id、legacy id 或 taskId 后缀）。`;
  }
  const lines: string[] = [];
  lines.push(`子代理 ${v.agentIds.join(", ")}`);
  // 旧轨迹里同一个子代理本就有两种 id（`subagent-<type>-<taskId>` 与 `<parent>-sub-<taskId>`），
  // 只有 taskId 后缀不同才是真的命中了多个子代理。
  const suffixes = new Set(v.agentIds.map((id) => id.slice(id.lastIndexOf("-") + 1)));
  if (suffixes.size > 1) {
    lines.push(`  ⚠ 查询 "${v.query}" 命中多个子代理，下方事件是它们的合集；请用完整 id 精确查询`);
  }
  if (v.parentToolCall) {
    lines.push(
      `  父调用: PreToolUse(sub_agent) tool_use_id=${v.parentToolCall.tool_use_id}` +
        (v.parentToolCall.timestamp
          ? ` @ ${v.parentToolCall.timestamp}`
          : " （父会话里未找到该 PreToolUse）"),
    );
  } else {
    lines.push("  父调用: 无 parent_tool_use_id（2026-10-14 前的旧轨迹，或非 sub_agent 派发）");
  }
  if (v.start) {
    lines.push(
      `  Start: type=${v.start.agent_type ?? "?"} description=${v.start.description ?? ""}`,
    );
  }
  if (v.stop) {
    lines.push(
      `  Stop:  status=${v.stop.status ?? "?"} elapsed_ms=${v.stop.elapsed_ms ?? "?"} turns=${v.stop.turns ?? "?"}`,
    );
  }
  lines.push(
    `  事件计数: ${Object.entries(v.counts)
      .map(([k, n]) => `${k}=${n}`)
      .join(" ")}`,
  );
  for (const r of v.requests) {
    const kv = Object.entries(r.summary)
      .map(([k, val]) => `${k}=${typeof val === "object" ? JSON.stringify(val) : String(val)}`)
      .join(" ");
    lines.push(`    ${r.timestamp ?? ""} ${r.event} ${kv}`);
  }
  return lines.join("\n");
}
