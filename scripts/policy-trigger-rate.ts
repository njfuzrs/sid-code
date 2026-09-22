#!/usr/bin/env bun
/**
 * policy-trigger-rate —— 企业策略触发率（M3 出口口径）
 *
 * 规划原文：分母是「相关任务」不是「所有任务」。双向对账：配了 deny 必须拦，没配必须放行。
 *
 * 两个数字一次打出（契约 §8 / 验收 §3）：
 *
 * | 指标 | 分子 | 分母 | 数据源 |
 * | A 权限 deny | permissions-audit.log 中 decision=deny 且 decisionReason.type=rule | 同窗口同 tool 的决策行（allow+deny） | ~/.sid-code/logs/permissions-audit.log（及 .1） |
 * | B 功能开关 | sidcode.defense.trigger 且 layer=policy_limits 且 outcome=blocked | 相关任务会话（实际调用了被关功能） | events.jsonl / telemetry/metrics.jsonl |
 *
 * B 的数据若根本没采到（events 里没有 metric 行、telemetry 也没有），打印
 * 「B 无数据，跳过」——不要 0.0% 假装采过。
 *
 * 用法：
 *   bun scripts/policy-trigger-rate.ts
 *   bun scripts/policy-trigger-rate.ts --limit 20
 *   bun scripts/policy-trigger-rate.ts --all
 *   bun scripts/policy-trigger-rate.ts --json
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { resolvePaths, listSessions } from "@sid-code/core/trace/digest.ts";

export const KNOWN_FLAGS = new Set(["--json", "--limit", "--all"]);

const DEFENSE_TRIGGER = "sidcode.defense.trigger";

export interface AuditRow {
  timestamp?: string;
  tool?: string;
  decision?: string;
  decisionReason?: { type?: string };
}

export interface RateA {
  denies_by_rule: number;
  decisions_same_tools: number;
  rate_a: number | null;
  tools: string[];
}

export interface RateB {
  available: boolean;
  blocked: number;
  related_sessions: number;
  rate_b: number | null;
}

export interface PolicyTriggerResult {
  denies_by_rule: number;
  decisions_same_tools: number;
  rate_a: number | null;
  window: {
    source: string;
    files: string[];
    lines: number;
    mtime?: string;
    sessionLimit: number | "all";
    sessionsScanned: number;
  };
  b: RateB;
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function parseAuditLine(line: string): AuditRow | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as AuditRow;
  } catch {
    return null;
  }
}

function readAuditFiles(): { rows: AuditRow[]; files: string[]; lines: number; mtimeMs?: number } {
  const primary = sidPaths.log("permissions-audit.log");
  const rotated = `${primary}.1`;
  const files: string[] = [];
  const rows: AuditRow[] = [];
  let lines = 0;
  let mtimeMs: number | undefined;

  for (const p of [primary, rotated]) {
    if (!existsSync(p)) continue;
    files.push(p);
    try {
      const st = statSync(p);
      mtimeMs = mtimeMs == null ? st.mtimeMs : Math.max(mtimeMs, st.mtimeMs);
    } catch {
      /* ignore */
    }
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      lines++;
      const row = parseAuditLine(line);
      if (row) rows.push(row);
    }
  }
  return { rows, files, lines, mtimeMs };
}

/** 分子 = deny ∧ reason.type=rule；分母 = 那些 tool 在同期 audit 里的全部决策。 */
export function computeRateA(rows: AuditRow[]): RateA {
  const ruleDenies = rows.filter(
    (r) => r.decision === "deny" && r.decisionReason?.type === "rule" && r.tool,
  );
  const tools = [...new Set(ruleDenies.map((r) => String(r.tool)))];
  const toolSet = new Set(tools);
  // 还没有任何 rule deny 时，用 bash 决策当相关任务分母（宁可窄），不要拿全量工具行稀释。
  const denomRows =
    toolSet.size > 0
      ? rows.filter((r) => r.tool && toolSet.has(String(r.tool)))
      : rows.filter((r) => r.tool === "bash");
  const decisions_same_tools = denomRows.length;
  const denies_by_rule = ruleDenies.length;
  return {
    denies_by_rule,
    decisions_same_tools,
    rate_a: decisions_same_tools === 0 ? null : denies_by_rule / decisions_same_tools,
    tools: toolSet.size > 0 ? tools : ["bash"],
  };
}

const RELATED_PROMPT_KEYWORDS = ["curl", "外网", "执行命令"];

function isRelatedSession(dir: string): { related: boolean; hasEvents: boolean } {
  const p = join(dir, "events.jsonl");
  if (!existsSync(p)) return { related: false, hasEvents: false };
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return { related: false, hasEvents: true };
  }
  let related = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = ev.event;
    const data = ev.data ?? {};
    if (kind === "PreToolUse") {
      const tn = String(data.tool_name ?? "").toLowerCase();
      if (tn === "bash") related = true;
    } else if (kind === "UserPromptSubmit" && typeof data.prompt === "string") {
      const prompt = data.prompt as string;
      const lower = prompt.toLowerCase();
      if (RELATED_PROMPT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) related = true;
    }
    if (related) break;
  }
  return { related, hasEvents: true };
}

function metricName(obj: any): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.metric === "string") return obj.metric;
  if (typeof obj.data?.name === "string") return obj.data.name;
  return undefined;
}

function metricAttrs(obj: any): Record<string, unknown> {
  if (obj?.attributes && typeof obj.attributes === "object") return obj.attributes;
  if (obj?.data?.attributes && typeof obj.data.attributes === "object") return obj.data.attributes;
  return {};
}

function scanMetricsJsonl(path: string): { sawAnyMetric: boolean; blocked: number } {
  let sawAnyMetric = false;
  let blocked = 0;
  if (!existsSync(path)) return { sawAnyMetric, blocked };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { sawAnyMetric, blocked };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const name = metricName(ev);
    if (!name) continue;
    sawAnyMetric = true;
    if (name !== DEFENSE_TRIGGER) continue;
    const attrs = metricAttrs(ev);
    if (
      attrs["sidcode.defense.layer"] === "policy_limits" &&
      attrs["sidcode.defense.outcome"] === "blocked"
    ) {
      blocked++;
    }
  }
  return { sawAnyMetric, blocked };
}

export function computePolicyTriggerRate(opts: {
  sessionLimit: number | "all";
}): PolicyTriggerResult {
  const audit = readAuditFiles();
  const a = computeRateA(audit.rows);

  const paths = resolvePaths();
  const refs = listSessions(paths);
  const picked =
    opts.sessionLimit === "all"
      ? refs
      : refs.slice(0, opts.sessionLimit === Infinity ? refs.length : opts.sessionLimit);

  let related = 0;
  let eventsMetric = { sawAnyMetric: false, blocked: 0 };
  for (const ref of picked) {
    const rel = isRelatedSession(ref.dir);
    if (rel.related) related++;
    const ev = scanMetricsJsonl(join(ref.dir, "events.jsonl"));
    eventsMetric.sawAnyMetric = eventsMetric.sawAnyMetric || ev.sawAnyMetric;
    eventsMetric.blocked += ev.blocked;
  }
  const tel = scanMetricsJsonl(join(sidPaths.telemetry(), "metrics.jsonl"));
  const sawB = eventsMetric.sawAnyMetric || tel.sawAnyMetric;
  const blocked = eventsMetric.blocked + tel.blocked;

  const b: RateB = sawB
    ? {
        available: true,
        blocked,
        related_sessions: related,
        rate_b: related === 0 ? null : blocked / related,
      }
    : { available: false, blocked: 0, related_sessions: related, rate_b: null };

  return {
    denies_by_rule: a.denies_by_rule,
    decisions_same_tools: a.decisions_same_tools,
    rate_a: a.rate_a,
    window: {
      source: "permissions-audit.log",
      files: audit.files,
      lines: audit.lines,
      mtime: audit.mtimeMs ? new Date(audit.mtimeMs).toISOString() : undefined,
      sessionLimit: opts.sessionLimit,
      sessionsScanned: picked.length,
    },
    b,
  };
}

function parseArgs(argv: string[]): { json: boolean; sessionLimit: number | "all" } {
  const unknown = argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(`未知参数: ${unknown.join(", ")}\n已知: ${[...KNOWN_FLAGS].join(" ")}\n`);
    process.exit(2);
  }
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const limIdx = argv.indexOf("--limit");
  const sessionLimit: number | "all" = all
    ? "all"
    : limIdx >= 0
      ? Number(argv[limIdx + 1]) || 200
      : 200;
  return { json, sessionLimit };
}

function main(): void {
  const { json, sessionLimit } = parseArgs(process.argv.slice(2));
  const result = computePolicyTriggerRate({ sessionLimit });

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const L: string[] = [];
  L.push("═══ 企业策略触发率 ═══");
  L.push(
    `窗口：${result.window.source}  行数=${result.window.lines}  mtime=${result.window.mtime ?? "—"}  会话扫描=${result.window.sessionsScanned}`,
  );
  if (result.window.files.length === 0) {
    L.push("未找到 permissions-audit.log（及 .1）。先跑一条会被策略拦的会话。");
  }
  L.push("");
  L.push(
    "A 权限规则拒绝（分子 = denies_by_rule = permissions-audit deny(rule)；分母 = decisions_same_tools = 同期同 tool 决策）：",
  );
  L.push(
    `  权限规则拒绝: ${result.denies_by_rule}/${result.decisions_same_tools}  (permissions-audit deny(rule) / 同期同 tool 决策)  ${result.rate_a == null ? "—" : pct(result.denies_by_rule, result.decisions_same_tools)}`,
  );
  L.push("");
  if (!result.b.available) {
    L.push(
      "B 功能开关（policy_limits）：B 无数据，跳过（events.jsonl / telemetry/metrics.jsonl 里没有 metric 行，不是 0.0%）",
    );
  } else {
    L.push(
      `B 功能开关: ${result.b.blocked}/${result.b.related_sessions}  (sidcode.defense.trigger layer=policy_limits outcome=blocked / 相关任务会话)`,
    );
  }
  L.push("");
  if (result.decisions_same_tools === 0) {
    L.push(
      "判读：分母=0 → 窗口里没相关任务（没有 bash / 所配 deny 对应工具的决策）。换更大 --limit 或先跑一条 curl 会话。",
    );
  } else if (result.denies_by_rule === 0) {
    L.push("判读：0 且分母>0 → 防线空转（相关任务里 rule deny 一次都没触发）。");
  } else {
    L.push("判读：A 分子>0，远程/本地 deny 规则在真实决策里被用过。");
  }
  process.stdout.write(L.join("\n") + "\n");
}

if (import.meta.main) {
  main();
}
