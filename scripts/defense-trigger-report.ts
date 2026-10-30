#!/usr/bin/env bun
/**
 * defense-trigger-report —— AgenticLoop 防线触发率报告（按模型拆）
 *
 * 背景（docs-research/.../20261030-AgenticLoop防线治理-横向剖析第四节落地总体方案.md T1）：
 * 「这道防线触发了几次」此前每次都靠手写 grep，手工统计踩过两个坑：
 *   ① 各字段落盘起始日期不同（continue_counts 10-24、tool_use_facts 10-29），覆盖期不齐还混着除；
 *   ② 没按模型拆 —— 防线大多是给弱模型补的，强模型上的零触发不能推出「防线没用」。
 * 本脚本把口径固化。和 `defense-trigger-rate.ts` 不是一回事：那个只看假设登记/对抗验证
 * 三个工具在审计类任务里的调用率，这个看主循环的 continue / 闸门 / 收尾 / 停滞防线。
 *
 * 取数源（写死，改了要同步改测试）：
 *   - `LoopTransition.type`                       → 各 continue 理由触发次数
 *   - `GateExhausted.gate`                        → 闸门耗尽次数
 *   - `TurnComplete.incomplete_reason` / `gates_exhausted` / `continue_counts`
 *   - `StallEscalation.level` + `acted`           → L1 / L2（acted=false 即影子）
 *   - `NoProgressNagInjected.kind`、`EndTurnShape.kind`
 *   - `AfterModel.stop_reason=max_tokens`         → 截断次数
 *
 * 模型归属：事件归到本会话**最近一条 `BeforeModel.data.model`**（会话中途 /model 切换时
 * 跟着换），provider 取同一模型在 `BilledRequest.provider` 上最后见到的值。
 * 还没发过请求的事件归到 `SessionStart.data.model`，都没有则记 `unknown`。
 *
 * 分母（写死）：sessions = 有 SessionStart 的会话；prompts = UserPromptSubmit 条数。
 * 剔除单测污染：会话首个带 cwd 的事件落在系统临时目录下的整会话跳过（计入 excluded）。
 *
 * 用法：
 *   bun scripts/defense-trigger-report.ts                 # 全部会话
 *   bun scripts/defense-trigger-report.ts --since 2026-10-24
 *   bun scripts/defense-trigger-report.ts --by provider   # 按 provider 分组（默认 model）
 *   bun scripts/defense-trigger-report.ts --json
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "@sid-code/core/trace/digest.ts";

export const KNOWN_FLAGS = new Set(["--json", "--since", "--by"]);

/**
 * `ContinueReason["type"]` 的全集（`packages/core/src/query/types.ts`）。
 * 必须列全：零触发的理由也要出现在报告里，否则「0 次」和「没统计」分不开。
 * `tests/scripts/defense-trigger-report.test.ts` 读源码联合类型对账，漏一个就红。
 */
export const CONTINUE_TYPES = [
  "tool_use",
  "max_tokens_continuation",
  "max_tokens_escalate",
  "reactive_compact",
  "loop_recovery",
  "context_overflow_retry",
  "stop_hook_retry",
  "timeout_retry",
  "todo_gate_retry",
  "unanswered_retry",
  "promise_nudge",
  "hypothesis_gate_retry",
  "goal_gate_retry",
  "goal_budget_warning",
  "empty_param_retry",
  "token_budget_continuation",
  "context_window_recovery",
] as const;

/** 覆盖期探测：字段名 → 判定该事件「带了这个字段」的谓词。报告里给出各自最早出现日期。 */
const COVERAGE_PROBES: Record<string, (e: TraceEvent) => boolean> = {
  LoopTransition: (e) => e.event === "LoopTransition",
  TurnComplete: (e) => e.event === "TurnComplete",
  "TurnComplete.continue_counts": (e) => e.event === "TurnComplete" && !!e.data?.continue_counts,
  // tool_use_facts 是平铺进 AfterModelRaw 的（trace/collector.ts），不在 AfterModel 上，也没有嵌套键
  "AfterModelRaw.tool_use_total": (e) =>
    e.event === "AfterModelRaw" && typeof e.data?.tool_use_total === "number",
  GateExhausted: (e) => e.event === "GateExhausted",
  StallEscalation: (e) => e.event === "StallEscalation",
  EndTurnShape: (e) => e.event === "EndTurnShape",
  NoProgressNagInjected: (e) => e.event === "NoProgressNagInjected",
};

export interface TraceEvent {
  event?: string;
  session_id?: string;
  timestamp?: string;
  cwd?: string;
  data?: Record<string, any>;
}

/** 一条计数：次数 + 涉及会话数 */
export interface Count {
  count: number;
  sessions: number;
}

export interface GroupReport {
  /** 分组键（模型名或 provider） */
  key: string;
  sessions: number;
  prompts: number;
  model_calls: number;
  continue: Record<string, Count>;
  gates_exhausted: Record<string, Count>;
  incomplete_reason: Record<string, Count>;
  stall: Record<string, Count>;
  nag: Record<string, Count>;
  end_turn_shape: Record<string, Count>;
  stop_max_tokens: Count;
  turn_complete: number;
}

export interface DefenseReport {
  window: { since: string | null; first: string | null; last: string | null };
  group_by: "model" | "provider";
  denominators: { sessions: number; prompts: number; excluded_tmp_sessions: number };
  /** 各字段最早出现日期（YYYY-MM-DD）；null = 窗口内从未出现 */
  coverage: Record<string, string | null>;
  total: GroupReport;
  groups: GroupReport[];
}

function emptyGroup(key: string): GroupReport {
  const cont: Record<string, Count> = {};
  for (const t of CONTINUE_TYPES) cont[t] = { count: 0, sessions: 0 };
  return {
    key,
    sessions: 0,
    prompts: 0,
    model_calls: 0,
    continue: cont,
    gates_exhausted: {},
    incomplete_reason: {},
    stall: {},
    nag: {},
    end_turn_shape: {},
    stop_max_tokens: { count: 0, sessions: 0 },
    turn_complete: 0,
  };
}

/** 判断 cwd 是否落在系统临时目录（单测 spawn 的会话） */
export function isTmpCwd(cwd: string | undefined, tmpRoots: string[]): boolean {
  if (!cwd) return false;
  return tmpRoots.some((r) => cwd === r || cwd.startsWith(r + "/"));
}

export function defaultTmpRoots(): string[] {
  const t = tmpdir().replace(/\/+$/, "");
  const roots = new Set([t, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]);
  if (t.startsWith("/var/")) roots.add("/private" + t);
  return [...roots];
}

/**
 * 单会话内的计数器：先按「分组键 + 指标 + 子键」累计次数，并记下本会话命中过哪些
 * 组合 —— 会话数要按会话去重，不能直接加次数。
 */
class SessionTally {
  readonly hits = new Map<string, number>();
  readonly groups = new Set<string>();
  add(group: string, metric: string, sub: string, n = 1): void {
    const k = `${group}\u0000${metric}\u0000${sub}`;
    this.hits.set(k, (this.hits.get(k) ?? 0) + n);
  }
}

export interface AggregateOptions {
  since?: string | null;
  groupBy?: "model" | "provider";
  tmpRoots?: string[];
}

/** 纯函数：把多会话的事件流聚合成报告（测试直接喂事件，不走磁盘） */
export function aggregateDefenseReport(
  sessions: Iterable<TraceEvent[]>,
  opts: AggregateOptions = {},
): DefenseReport {
  const groupBy = opts.groupBy ?? "model";
  const since = opts.since ?? null;
  const tmpRoots = opts.tmpRoots ?? defaultTmpRoots();
  const groups = new Map<string, GroupReport>();
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
    const firstCwd = events.find((e) => e.cwd)?.cwd;
    if (isTmpCwd(firstCwd, tmpRoots)) {
      excluded++;
      continue;
    }
    // provider 映射要在整会话上先扫一遍：BilledRequest 在 AfterModel 之后才到
    const providerOf = new Map<string, string>();
    for (const e of events) {
      if (e.event === "BilledRequest" && e.data?.model && e.data?.provider) {
        providerOf.set(String(e.data.model), String(e.data.provider));
      }
    }
    const start = events.find((e) => e.event === "SessionStart");
    let model: string = start?.data?.model ? String(start.data.model) : "unknown";
    const keyOf = () => (groupBy === "provider" ? (providerOf.get(model) ?? "unknown") : model);
    const tally = new SessionTally();
    let sawStart = false;

    for (const e of events) {
      const ts = e.timestamp;
      if (since && ts && ts.slice(0, 10) < since) continue;
      if (ts) {
        if (!first || ts < first) first = ts;
        if (!last || ts > last) last = ts;
        for (const [name, probe] of Object.entries(COVERAGE_PROBES)) {
          const day = ts.slice(0, 10);
          if (probe(e) && (!coverage[name] || day < coverage[name]!)) coverage[name] = day;
        }
      }
      const d = e.data ?? {};
      switch (e.event) {
        case "SessionStart":
          sawStart = true;
          if (d.model) model = String(d.model);
          tally.groups.add(keyOf());
          break;
        case "BeforeModel":
          if (d.model) model = String(d.model);
          tally.add(keyOf(), "model_calls", "");
          tally.groups.add(keyOf());
          break;
        case "UserPromptSubmit":
          tally.add(keyOf(), "prompts", "");
          break;
        case "LoopTransition":
          tally.add(keyOf(), "continue", String(d.type ?? "unknown"));
          break;
        case "GateExhausted":
          tally.add(keyOf(), "gates_exhausted", String(d.gate ?? "unknown"));
          break;
        case "TurnComplete":
          tally.add(keyOf(), "turn_complete", "");
          if (d.incomplete_reason) {
            tally.add(keyOf(), "incomplete_reason", String(d.incomplete_reason));
          }
          break;
        case "StallEscalation":
          tally.add(keyOf(), "stall", `L${d.level ?? "?"}${d.acted === false ? "_shadow" : ""}`);
          break;
        case "NoProgressNagInjected":
          tally.add(keyOf(), "nag", String(d.kind ?? "unknown"));
          break;
        case "EndTurnShape":
          tally.add(keyOf(), "end_turn_shape", String(d.kind ?? "unknown"));
          break;
        case "AfterModel":
          if (d.stop_reason === "max_tokens") tally.add(keyOf(), "stop_max_tokens", "");
          break;
      }
    }

    if (sawStart) {
      total.sessions++;
      for (const k of tally.groups) group(k).sessions++;
    }
    // 分组：每个 (分组, 指标, 子键) 组合本会话 +1 会话；总计：先抹掉分组维度再落，
    // 否则一个会话中途换模型、两个分组都命中时，总计会把它算成两个会话
    const merged = new Map<string, number>();
    for (const [k, n] of tally.hits) {
      const [gk, metric, sub] = k.split("\u0000") as [string, string, string];
      applyHit(group(gk), metric, sub, n);
      const mk = `${metric}\u0000${sub}`;
      merged.set(mk, (merged.get(mk) ?? 0) + n);
    }
    for (const [mk, n] of merged) {
      const [metric, sub] = mk.split("\u0000") as [string, string];
      applyHit(total, metric, sub, n);
    }
  }

  return {
    window: { since, first, last },
    group_by: groupBy,
    denominators: {
      sessions: total.sessions,
      prompts: total.prompts,
      excluded_tmp_sessions: excluded,
    },
    coverage,
    total,
    groups: [...groups.values()]
      .filter((g) => g.sessions > 0 || g.model_calls > 0)
      .sort((a, b) => b.model_calls - a.model_calls),
  };
}

function bump(map: Record<string, Count>, sub: string, n: number): void {
  const c = (map[sub] ??= { count: 0, sessions: 0 });
  c.count += n;
  c.sessions++;
}

function applyHit(g: GroupReport, metric: string, sub: string, n: number): void {
  switch (metric) {
    case "prompts":
      g.prompts += n;
      return;
    case "model_calls":
      g.model_calls += n;
      return;
    case "turn_complete":
      g.turn_complete += n;
      return;
    case "stop_max_tokens":
      g.stop_max_tokens.count += n;
      g.stop_max_tokens.sessions++;
      return;
    case "continue":
    case "gates_exhausted":
    case "incomplete_reason":
    case "stall":
    case "nag":
    case "end_turn_shape":
      bump(g[metric], sub, n);
      return;
  }
}

// ─────────────────────────── 磁盘读取 ───────────────────────────

function readEvents(path: string): TraceEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as TraceEvent);
    } catch {
      /* 损坏行跳过 */
    }
  }
  return out;
}

/** 逐会话产出事件流。不走 listSessions：它要求 session.traj 存在，会漏掉只有 events.jsonl 的会话 */
export function* iterSessionEvents(sessionsDir: string): Generator<TraceEvent[]> {
  if (!existsSync(sessionsDir)) return;
  for (const id of readdirSync(sessionsDir).sort()) {
    if (id.startsWith(".")) continue;
    const p = join(sessionsDir, id, "events.jsonl");
    if (existsSync(p)) yield readEvents(p);
  }
}

// ─────────────────────────── 渲染 ───────────────────────────

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(2)}%` : "-";
}

export function renderText(r: DefenseReport): string {
  const L: string[] = [];
  const { sessions, prompts, excluded_tmp_sessions } = r.denominators;
  L.push("# 防线触发率报告");
  L.push(
    `窗口: ${r.window.since ? `since ${r.window.since}` : "全部"}（实际 ${r.window.first?.slice(0, 10) ?? "-"} ~ ${r.window.last?.slice(0, 10) ?? "-"}）`,
  );
  L.push(
    `分母: 会话 ${sessions}（SessionStart）· 用户消息 ${prompts}（UserPromptSubmit）· 剔除 tmp 会话 ${excluded_tmp_sessions}`,
  );
  L.push("");
  L.push("## 字段覆盖期（最早出现日期；晚于窗口起点的字段，其计数只代表这之后）");
  const start = r.window.since ?? r.window.first?.slice(0, 10) ?? null;
  for (const [k, v] of Object.entries(r.coverage)) {
    const flag = v === null ? "  ⚠ 窗口内从未出现" : start && v > start ? "  ⚠ 覆盖不足" : "";
    L.push(`  ${k.padEnd(30)} ${v ?? "-"}${flag}`);
  }

  const section = (title: string, pick: (g: GroupReport) => Record<string, Count>) => {
    L.push("");
    L.push(`## ${title}`);
    const keys = Object.keys(pick(r.total)).sort(
      (a, b) => pick(r.total)[b]!.count - pick(r.total)[a]!.count || a.localeCompare(b),
    );
    if (keys.length === 0) {
      L.push("  （窗口内 0 条）");
      return;
    }
    L.push(
      `  ${"类型".padEnd(28)} ${"次数".padStart(7)} ${"会话".padStart(5)} ${"/消息".padStart(8)}`,
    );
    for (const k of keys) {
      const c = pick(r.total)[k]!;
      const zero = c.count === 0 ? "  ← 零触发" : "";
      L.push(
        `  ${k.padEnd(28)} ${String(c.count).padStart(7)} ${String(c.sessions).padStart(5)} ${pct(c.count, prompts).padStart(8)}${zero}`,
      );
    }
  };
  section("continue 理由（LoopTransition.type）", (g) => g.continue);
  section("闸门耗尽（GateExhausted.gate）", (g) => g.gates_exhausted);
  section(
    `非正常收尾（TurnComplete.incomplete_reason，共 ${r.total.turn_complete} 条 TurnComplete）`,
    (g) => g.incomplete_reason,
  );
  section("停滞升级（StallEscalation，_shadow = acted:false）", (g) => g.stall);
  section("无进展回注（NoProgressNagInjected.kind）", (g) => g.nag);
  section("end_turn 形态（EndTurnShape.kind）", (g) => g.end_turn_shape);
  L.push("");
  L.push(
    `## 截断：AfterModel stop_reason=max_tokens ${r.total.stop_max_tokens.count} 次 / ${r.total.model_calls} 次调用（${pct(r.total.stop_max_tokens.count, r.total.model_calls)}）`,
  );

  // 按分组拆：只列非 tool_use 的防线触发，tool_use 是正常路径
  L.push("");
  L.push(`## 按 ${r.group_by} 拆（只列触发过的防线；tool_use 不计）`);
  for (const g of r.groups) {
    const parts: string[] = [];
    const push = (prefix: string, m: Record<string, Count>) => {
      for (const [k, c] of Object.entries(m)) {
        if (c.count > 0 && !(prefix === "" && k === "tool_use"))
          parts.push(`${prefix}${k}=${c.count}`);
      }
    };
    push("", g.continue);
    push("exhaust:", g.gates_exhausted);
    push("incomplete:", g.incomplete_reason);
    push("stall:", g.stall);
    if (g.stop_max_tokens.count) parts.push(`max_tokens=${g.stop_max_tokens.count}`);
    L.push(
      `  ${g.key}  会话 ${g.sessions} · 消息 ${g.prompts} · 调用 ${g.model_calls}${parts.length ? "\n      " + parts.join("  ") : "  （无防线触发）"}`,
    );
  }
  return L.join("\n");
}

// ─────────────────────────── CLI ───────────────────────────

export function parseArgs(argv: string[]): {
  json: boolean;
  since: string | null;
  by: "model" | "provider";
} {
  let json = false;
  let since: string | null = null;
  let by: "model" | "provider" = "model";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!KNOWN_FLAGS.has(a))
      throw new Error(`未知参数: ${a}（可用: ${[...KNOWN_FLAGS].join(" ")}）`);
    if (a === "--json") json = true;
    else if (a === "--since") {
      since = argv[++i] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since))
        throw new Error(`--since 需要 YYYY-MM-DD，收到: ${since}`);
    } else if (a === "--by") {
      const v = argv[++i];
      if (v !== "model" && v !== "provider")
        throw new Error(`--by 只接受 model | provider，收到: ${v}`);
      by = v;
    }
  }
  return { json, since, by };
}

function main(): void {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    process.exit(2);
  }
  const paths = resolvePaths();
  const report = aggregateDefenseReport(iterSessionEvents(paths.sessionsDir), {
    since: args.since,
    groupBy: args.by,
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : renderText(report));
}

if (import.meta.main) {
  main();
}
