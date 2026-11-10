#!/usr/bin/env bun
/**
 * aftereffect-report —— 引导规则的后效指标（按模型拆）
 *
 * 背景（Harness 厚薄归位专项 HB-3 / 后续规划 ⑨，01 §4.3）：防线注册表与 defense-trigger-report
 * 回答「触发了几次」，回答不了「触发之后模型做了什么」。M4 要对 todo 系列、读写提示、
 * 清理占位文案做 A/B，没有后效就只能比触发次数 —— 而触发次数下降可能只是「换了个地方浪费」。
 *
 * 三个后效，口径写死（改了要同步改测试）：
 *
 * 1. **nag 之后第一个工具**（`NoProgressNagInjected` → 同会话下一条 `PreToolUse`）
 *    分子按工具名分桶；关注 `todo_write` 占比：高 = 催促主要换来的是「补记账」，不是推进主线
 *    （01 §2.3 的嫌疑）。分母 = 之后确实有工具调用的 nag 数；之后再无工具的单列 `no_tool_after`。
 *
 * 2. **ReadHint 之后同文件下一次 read 是否改了读法**（`ReadHint` → 同会话同 `input_summary.file_path`
 *    的下一条 read `PreToolUse`）
 *    - `followed`：下一次读不传 limit（整读）—— 只对 `suggest_full_read=true` 的提示算
 *    - `still_narrow`：仍传 limit / offset；再拆出 `still_narrow_overlap`（起始行落在提示窗口内 =
 *      同一段反复读）。窗口外是换段读，属正常推进，不能当成「提示无效」
 *    - `no_reread`：之后没再读这个文件（复用已读内容，也算遵从，但单列）
 *    路径取 `ReadHint.hint_file_path`；`input_summary` 自 G1 起才有，覆盖期见报告头。
 *
 * 3. **清理后 N 轮内同签名重跑**（`ToolResultCleared` → 被清 `tool_use_id` 的签名，在清理之后
 *    `RERUN_WINDOW_TOOLS` 次工具调用内再次出现）
 *    签名 = 工具名 + `input_summary` 的稳定 JSON。`input_summary` 缺失的调用不计签名（不进分母）。
 *    `ToolResultCleared` 是 HB-4（#726）新增事件，之前的会话这一项为空，**不是 0**。
 *
 * 模型归属与 tmp 会话剔除复用 defense-trigger-report 的口径（最近一条 BeforeModel.model）。
 * 子代理（带 agent_id 的 PreToolUse）不进统计：nag / ReadHint 的 agent 归属不全，混进来会错配。
 *
 * 用法：
 *   bun scripts/aftereffect-report.ts    # 全部会话
 *   bun scripts/aftereffect-report.ts --since 2026-11-01
 *   bun scripts/aftereffect-report.ts --json
 */

import { resolvePaths } from "@sid-code/core/trace/digest.ts";
import {
  defaultTmpRoots,
  isTmpCwd,
  iterSessionEvents,
  type TraceEvent,
} from "./defense-trigger-report.ts";

export const KNOWN_FLAGS = new Set(["--json", "--since"]);

/** 清理后多少次工具调用内算「重跑」。对齐 01 §2.2 的「N 轮内」，取 10 次工具调用 */
export const RERUN_WINDOW_TOOLS = 10;

export interface NagAfter {
  /** 之后确实有工具调用的 nag 数（分母） */
  with_tool_after: number;
  no_tool_after: number;
  /** 第一个工具名 → 次数 */
  first_tool: Record<string, number>;
}

export interface ReadHintAfter {
  hints: number;
  followed: number;
  still_narrow: number;
  /** still_narrow 的拆分：下一次窗口与提示窗口重叠（真·重复窄读）。其余是换段读（往前或往后） */
  still_narrow_overlap: number;
  no_reread: number;
  /** 提示本身没建议整读（repeat_narrow 且文件过大），不进 followed / still_narrow 的分母 */
  not_applicable: number;
}

export interface ClearAfter {
  clear_events: number;
  /** 被清且有签名的调用数（分母） */
  cleared_with_signature: number;
  /** 其中在窗口内被同签名重跑的数 */
  rerun_within_window: number;
  by_stage: Record<string, { cleared_with_signature: number; rerun_within_window: number }>;
}

export interface AftereffectGroup {
  key: string;
  sessions: number;
  nag: Record<string, NagAfter>;
  read_hint: Record<string, ReadHintAfter>;
  cleared: ClearAfter;
}

export interface AftereffectReport {
  window: { since: string | null; first: string | null; last: string | null };
  denominators: { sessions: number; excluded_tmp_sessions: number };
  coverage: Record<string, string | null>;
  total: AftereffectGroup;
  groups: AftereffectGroup[];
}

const COVERAGE_PROBES: Record<string, (e: TraceEvent) => boolean> = {
  NoProgressNagInjected: (e) => e.event === "NoProgressNagInjected",
  ReadHint: (e) => e.event === "ReadHint",
  "PreToolUse.input_summary": (e) => e.event === "PreToolUse" && !!e.data?.input_summary,
  ToolResultCleared: (e) => e.event === "ToolResultCleared",
};

function emptyGroup(key: string): AftereffectGroup {
  return {
    key,
    sessions: 0,
    nag: {},
    read_hint: {},
    cleared: { clear_events: 0, cleared_with_signature: 0, rerun_within_window: 0, by_stage: {} },
  };
}

/** 稳定签名：键排序后的 JSON。只用 input_summary（白名单键，已截断），不碰原始入参 */
export function toolSignature(toolName: string, summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return null;
  const obj = summary as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `${toolName}:${JSON.stringify(keys.map((k) => [k, obj[k]]))}`;
}

interface ToolCall {
  idx: number;
  name: string;
  id: string;
  sig: string | null;
  filePath: string | null;
  hasLimit: boolean;
  /** read 的起始行（未传 offset 视为 1）；非 read 为 null */
  offset: number | null;
}

/** 单会话内的派生：返回 (模型, 指标增量) 列表，由调用方并入分组与总计 */
function analyzeSession(events: TraceEvent[], since: string | null) {
  const start = events.find((e) => e.event === "SessionStart");
  let model: string = start?.data?.model ? String(start.data.model) : "unknown";
  const modelAt: string[] = [];
  const tools: ToolCall[] = [];
  const toolPosAtEvent: number[] = [];
  const byId = new Map<string, ToolCall>();

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const d = e.data ?? {};
    if (e.event === "BeforeModel" && d.model) model = String(d.model);
    modelAt.push(model);
    toolPosAtEvent.push(tools.length);
    if (e.event === "PreToolUse" && !d.agent_id) {
      const name = String(d.tool_name ?? "unknown");
      const summary = d.input_summary as Record<string, unknown> | undefined;
      const call: ToolCall = {
        idx: i,
        name,
        id: String(d.tool_use_id ?? ""),
        sig: toolSignature(name, summary),
        filePath: typeof summary?.file_path === "string" ? summary.file_path : null,
        hasLimit: summary?.limit !== undefined || summary?.offset !== undefined,
        offset: typeof summary?.offset === "number" ? summary.offset : name === "read" ? 1 : null,
      };
      tools.push(call);
      if (call.id) byId.set(call.id, call);
    }
  }

  type Hit =
    | { model: string; kind: "nag"; sub: string; firstTool: string | null }
    | {
        model: string;
        kind: "hint";
        sub: string;
        outcome: "followed" | "still_narrow" | "no_reread" | "not_applicable";
        overlap: boolean;
      }
    | { model: string; kind: "clear_event" }
    | { model: string; kind: "clear"; stage: string; rerun: boolean };
  const hits: Hit[] = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (since && e.timestamp && e.timestamp.slice(0, 10) < since) continue;
    const d = e.data ?? {};
    const m = modelAt[i]!;
    // toolPosAtEvent[i] = 本事件之前已有几次工具调用，所以从这里往后就是「事件之后」的工具
    const after = tools.slice(toolPosAtEvent[i]!);

    if (e.event === "NoProgressNagInjected") {
      hits.push({
        model: m,
        kind: "nag",
        sub: String(d.kind ?? "unknown"),
        firstTool: after[0]?.name ?? null,
      });
    } else if (e.event === "ReadHint") {
      const file = typeof d.hint_file_path === "string" ? d.hint_file_path : null;
      const next = file ? after.find((t) => t.name === "read" && t.filePath === file) : undefined;
      let outcome: "followed" | "still_narrow" | "no_reread" | "not_applicable";
      if (d.suggest_full_read !== true) outcome = "not_applicable";
      else if (!next) outcome = "no_reread";
      else outcome = next.hasLimit ? "still_narrow" : "followed";
      // 重叠 = 下一次起始行落在提示窗口 [start_line, end_line] 内。落在窗口外是换段读（正常推进），
      // 不能与「同一段反复读」混算 —— 11 月实测 still_narrow 里 8 成是换段
      const start = Number(d.start_line);
      const end = Number(d.end_line);
      const overlap =
        outcome === "still_narrow" &&
        next?.offset != null &&
        next.offset >= start &&
        next.offset <= end;
      hits.push({ model: m, kind: "hint", sub: String(d.kind ?? "unknown"), outcome, overlap });
    } else if (e.event === "ToolResultCleared") {
      hits.push({ model: m, kind: "clear_event" });
      const ids = Array.isArray(d.tool_use_ids) ? (d.tool_use_ids as unknown[]) : [];
      const window = after.slice(0, RERUN_WINDOW_TOOLS);
      for (const raw of ids) {
        const call = byId.get(String(raw));
        if (!call?.sig) continue;
        const rerun = window.some((t) => t.sig === call.sig);
        hits.push({ model: m, kind: "clear", stage: String(d.stage ?? "unknown"), rerun });
      }
    }
  }
  return hits;
}

function apply(g: AftereffectGroup, h: ReturnType<typeof analyzeSession>[number]): void {
  switch (h.kind) {
    case "nag": {
      const n = (g.nag[h.sub] ??= { with_tool_after: 0, no_tool_after: 0, first_tool: {} });
      if (h.firstTool === null) n.no_tool_after++;
      else {
        n.with_tool_after++;
        n.first_tool[h.firstTool] = (n.first_tool[h.firstTool] ?? 0) + 1;
      }
      return;
    }
    case "hint": {
      const r = (g.read_hint[h.sub] ??= {
        hints: 0,
        followed: 0,
        still_narrow: 0,
        still_narrow_overlap: 0,
        no_reread: 0,
        not_applicable: 0,
      });
      r.hints++;
      r[h.outcome]++;
      if (h.overlap) r.still_narrow_overlap++;
      return;
    }
    case "clear_event":
      g.cleared.clear_events++;
      return;
    case "clear": {
      const s = (g.cleared.by_stage[h.stage] ??= {
        cleared_with_signature: 0,
        rerun_within_window: 0,
      });
      g.cleared.cleared_with_signature++;
      s.cleared_with_signature++;
      if (h.rerun) {
        g.cleared.rerun_within_window++;
        s.rerun_within_window++;
      }
      return;
    }
  }
}

export function aggregateAftereffects(
  sessions: Iterable<TraceEvent[]>,
  opts: { since?: string | null; tmpRoots?: string[] } = {},
): AftereffectReport {
  const since = opts.since ?? null;
  const tmpRoots = opts.tmpRoots ?? defaultTmpRoots();
  const groups = new Map<string, AftereffectGroup>();
  const total = emptyGroup("(all)");
  const coverage: Record<string, string | null> = {};
  for (const k of Object.keys(COVERAGE_PROBES)) coverage[k] = null;
  let excluded = 0;
  let first: string | null = null;
  let last: string | null = null;
  const group = (k: string) => {
    let g = groups.get(k);
    if (!g) groups.set(k, (g = emptyGroup(k)));
    return g;
  };

  for (const events of sessions) {
    if (isTmpCwd(events.find((e) => e.cwd)?.cwd, tmpRoots)) {
      excluded++;
      continue;
    }
    if (!events.some((e) => e.event === "SessionStart")) continue;
    for (const e of events) {
      const ts = e.timestamp;
      if (!ts || (since && ts.slice(0, 10) < since)) continue;
      if (!first || ts < first) first = ts;
      if (!last || ts > last) last = ts;
      const day = ts.slice(0, 10);
      for (const [name, probe] of Object.entries(COVERAGE_PROBES)) {
        if (probe(e) && (!coverage[name] || day < coverage[name]!)) coverage[name] = day;
      }
    }
    const hits = analyzeSession(events, since);
    total.sessions++;
    const seen = new Set<string>();
    for (const h of hits) {
      apply(group(h.model), h);
      apply(total, h);
      seen.add(h.model);
    }
    for (const k of seen) group(k).sessions++;
  }

  return {
    window: { since, first, last },
    denominators: { sessions: total.sessions, excluded_tmp_sessions: excluded },
    coverage,
    total,
    groups: [...groups.values()].sort((a, b) => b.sessions - a.sessions),
  };
}

// ─────────────────────────── 渲染 ───────────────────────────

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

function renderGroup(g: AftereffectGroup): string[] {
  const out: string[] = [`## ${g.key}（有后效事件的会话 ${g.sessions}）`];
  for (const [kind, n] of Object.entries(g.nag)) {
    const top = Object.entries(n.first_tool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([t, c]) => `${t} ${pct(c, n.with_tool_after)}`)
      .join("、");
    out.push(
      `- nag[${kind}]：之后有工具 ${n.with_tool_after}（todo_write ${pct(n.first_tool.todo_write ?? 0, n.with_tool_after)}），之后无工具 ${n.no_tool_after}；首工具 ${top || "—"}`,
    );
  }
  for (const [kind, r] of Object.entries(g.read_hint)) {
    const applicable = r.followed + r.still_narrow + r.no_reread;
    out.push(
      `- ReadHint[${kind}]：${r.hints} 次；建议整读的 ${applicable} 次中 改整读 ${pct(r.followed, applicable)}、仍窄读 ${pct(r.still_narrow, applicable)}（其中同段重叠 ${pct(r.still_narrow_overlap, applicable)}）、未再读 ${pct(r.no_reread, applicable)}；不适用 ${r.not_applicable}`,
    );
  }
  const c = g.cleared;
  out.push(
    c.clear_events === 0
      ? "- 清理后重跑：无 ToolResultCleared 事件（HB-4 #726 之前的会话没有这一项，不是 0）"
      : `- 清理后重跑：${c.clear_events} 次清理，有签名的被清调用 ${c.cleared_with_signature}，${RERUN_WINDOW_TOOLS} 次工具内同签名重跑 ${c.rerun_within_window}（${pct(c.rerun_within_window, c.cleared_with_signature)}）` +
          Object.entries(c.by_stage)
            .map(([s, v]) => `；${s} ${pct(v.rerun_within_window, v.cleared_with_signature)}`)
            .join(""),
  );
  return out;
}

export function renderText(r: AftereffectReport): string {
  const lines = [
    "# 引导规则后效报告",
    "",
    `窗口：${r.window.since ?? "全部"}（实际 ${r.window.first?.slice(0, 10) ?? "—"} ~ ${r.window.last?.slice(0, 10) ?? "—"}）；会话 ${r.denominators.sessions}，剔除 tmp ${r.denominators.excluded_tmp_sessions}`,
    `覆盖期：${Object.entries(r.coverage)
      .map(([k, v]) => `${k} ${v ?? "从未出现"}`)
      .join("；")}`,
    "",
    ...renderGroup(r.total),
    "",
  ];
  for (const g of r.groups) lines.push(...renderGroup(g), "");
  return lines.join("\n");
}

export function parseArgs(argv: string[]): { json: boolean; since: string | null } {
  let json = false;
  let since: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!KNOWN_FLAGS.has(a))
      throw new Error(`未知参数: ${a}（可用: ${[...KNOWN_FLAGS].join(" ")}）`);
    if (a === "--json") json = true;
    else if (a === "--since") {
      since = argv[++i] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since))
        throw new Error(`--since 需要 YYYY-MM-DD，收到: ${since}`);
    }
  }
  return { json, since };
}

function main(): void {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    process.exit(2);
  }
  const report = aggregateAftereffects(iterSessionEvents(resolvePaths().sessionsDir), {
    since: args.since,
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : renderText(report));
}

if (import.meta.main) {
  main();
}
