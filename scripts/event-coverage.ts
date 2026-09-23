#!/usr/bin/env bun
/**
 * event-coverage —— M4 三类审计事件覆盖率
 *
 * 规划原文：三类覆盖率 ≥95%。覆盖率不是「事件条数」，是「该发生的时候有没有发出来」。
 * 分母必须来自独立信号，不能来自埋点自己 —— 否则恒等于 100%，是个假指标。
 *
 * | 事件 | 分子 | 分母 |
 * | policy_enforced | telemetry/events.jsonl 同名条 | ~/.sid-code/audit.log 文本 POLICY 行 |
 * | guardrail_triggered | 同上（瞬时 unknown + 回填都算 emitted） | 会话 events.jsonl 里 sidcode.defense.trigger |
 * | context_assembled | 同上 | session.traj 的 total_api_calls × 生效采样率 |
 *
 * 窗口：`--limit N` = 最近 N 个会话的时间包络（按 session.traj mtime）。
 * `--all` 才扫全文件，输出 `window.all=true`，那种数不能进北极星。
 *
 * 分母 0 打印「无数据，跳过」，不许打 100%。coverage > 1.0 是 bug（分母算错或重复 emit）。
 *
 * 用法：
 *   bun scripts/event-coverage.ts
 *   bun scripts/event-coverage.ts --limit 20
 *   bun scripts/event-coverage.ts --all
 *   bun scripts/event-coverage.ts --json
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { resolvePaths, listSessions, type SessionRef } from "@sid-code/core/trace/digest.ts";
import { getFeatureValue_CACHED_MAY_BE_STALE } from "@sid-code/core/analytics/feature-flags.ts";

export const KNOWN_FLAGS = new Set(["--json", "--limit", "--all"]);

const DEFENSE_TRIGGER = "sidcode.defense.trigger";
export const ENVELOPE_PAD_MS = 10 * 60 * 1000;

/** audit.log 文本行：applyLoadedPolicy 自身不 log，行来自 interpret / cache / loader。 */
const POLICY_AUDIT_RE = /远程策略 (?:200|204|304)|回退缓存|无可用 200 缓存|缓存过期|加载本地策略/;

export interface CoverageRow {
  event: string;
  emitted: number;
  expected: number;
  sample_rate: number;
  coverage: number | null;
  skipped: boolean;
}

export interface EventCoverageResult {
  policy_enforced: CoverageRow;
  guardrail_triggered: CoverageRow;
  context_assembled: CoverageRow;
  window: {
    source: string;
    files: string[];
    from: string | null;
    to: string | null;
    appliedTo: "all";
    all: boolean;
    sessionLimit: number | "all";
    sessionsScanned: number;
  };
  startup_timing?: { n: number; p50?: number; p95?: number; p99?: number };
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

export function parseTimestampMs(ts: string | number | undefined): number | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts !== "string" || !ts) return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

export function sessionEnvelope(
  refs: SessionRef[],
  sessionLimit: number | "all",
): { fromMs: number; toMs: number; picked: SessionRef[]; all: boolean } | undefined {
  if (refs.length === 0) return undefined;
  const all = sessionLimit === "all";
  const picked = all ? refs : refs.slice(0, sessionLimit === Infinity ? refs.length : sessionLimit);
  if (picked.length === 0) return undefined;
  let fromMs = picked[0]!.mtimeMs;
  let toMs = picked[0]!.mtimeMs;
  for (const r of picked) {
    if (r.mtimeMs < fromMs) fromMs = r.mtimeMs;
    if (r.mtimeMs > toMs) toMs = r.mtimeMs;
  }
  fromMs -= ENVELOPE_PAD_MS;
  toMs += ENVELOPE_PAD_MS;
  return { fromMs, toMs, picked, all };
}

function listRotated(primary: string, extra: string[]): string[] {
  const out: string[] = [];
  for (const p of [primary, ...extra]) {
    if (existsSync(p)) out.push(p);
  }
  return out;
}

function telemetryEventFiles(): string[] {
  const dir = sidPaths.telemetry();
  const files = [join(dir, "events.jsonl")];
  for (let i = 1; i <= 5; i++) files.push(join(dir, `events.${i}.jsonl`));
  return listRotated(files[0]!, files.slice(1));
}

function auditLogFiles(): string[] {
  const primary = sidPaths.auditLog();
  return listRotated(primary, [`${primary}.1`]);
}

interface AnalyticsRow {
  eventName?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows;
}

function inWindow(ms: number | undefined, fromMs?: number, toMs?: number): boolean {
  if (fromMs == null || toMs == null) return true;
  if (ms == null) return false;
  return ms >= fromMs && ms <= toMs;
}

function countAnalytics(name: string, fromMs?: number, toMs?: number): number {
  let n = 0;
  for (const f of telemetryEventFiles()) {
    for (const row of readJsonl(f)) {
      const r = row as AnalyticsRow;
      if (r.eventName !== name) continue;
      if (!inWindow(parseTimestampMs(r.timestamp), fromMs, toMs)) continue;
      n++;
    }
  }
  return n;
}

function startupTimingStats(fromMs?: number, toMs?: number): EventCoverageResult["startup_timing"] {
  const vals: number[] = [];
  for (const f of telemetryEventFiles()) {
    for (const row of readJsonl(f)) {
      const r = row as AnalyticsRow;
      if (r.eventName !== "startup_timing") continue;
      if (!inWindow(parseTimestampMs(r.timestamp), fromMs, toMs)) continue;
      const d = r.metadata?.duration_ms;
      if (typeof d === "number" && Number.isFinite(d)) vals.push(d);
    }
  }
  if (vals.length === 0) return { n: 0 };
  vals.sort((a, b) => a - b);
  const q = (p: number) =>
    vals[Math.min(vals.length - 1, Math.max(0, Math.ceil(p * vals.length) - 1))]!;
  return { n: vals.length, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

/** 从 audit.log 文本行抽时间。格式 `[HH:MM:SS] ● [POLICY] …`，没有日期，用 mtime 当天拼。 */
export function parseAuditLineMs(line: string, fileMtimeMs: number): number | undefined {
  const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
  if (!m) return undefined;
  const d = new Date(fileMtimeMs);
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  const ms = d.getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export function countPolicyAuditLines(
  fromMs?: number,
  toMs?: number,
): { n: number; files: string[] } {
  const files = auditLogFiles();
  let n = 0;
  for (const f of files) {
    let raw: string;
    let mtimeMs = Date.now();
    try {
      raw = readFileSync(f, "utf8");
      mtimeMs = statSync(f).mtimeMs;
    } catch {
      continue;
    }
    // 行只有 [HH:MM:SS]，没有日期。用文件 mtime 判断整文件是否进窗，
    // 不要用 setHours 拼本地日期——CI / 开发机 TZ 不同会把分母静默算成 0。
    if (!inWindow(mtimeMs, fromMs, toMs)) continue;
    for (const line of raw.split("\n")) {
      if (!POLICY_AUDIT_RE.test(line)) continue;
      n++;
    }
  }
  return { n, files };
}

function metricName(obj: any): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.metric === "string") return obj.metric;
  if (typeof obj.data?.name === "string") return obj.data.name;
  if (typeof obj.event === "string" && obj.event === "metric") {
    return typeof obj.data?.name === "string" ? obj.data.name : undefined;
  }
  return undefined;
}

function countDefenseTriggers(dirs: string[]): number {
  let n = 0;
  for (const dir of dirs) {
    const p = join(dir, "events.jsonl");
    for (const row of readJsonl(p)) {
      const name = metricName(row);
      if (name === DEFENSE_TRIGGER) n++;
    }
    const tel = join(sidPaths.telemetry(), "metrics.jsonl");
    if (existsSync(tel) && dirs.length > 0) {
      /* 会话级分母优先走会话 events.jsonl；telemetry/metrics.jsonl 是进程级，下面单独加一次 */
    }
  }
  return n;
}

function countDefenseTriggersTelemetry(): number {
  let n = 0;
  const tel = join(sidPaths.telemetry(), "metrics.jsonl");
  for (const row of readJsonl(tel)) {
    if (metricName(row) === DEFENSE_TRIGGER) n++;
  }
  return n;
}

function readTotalApiCalls(trajPath: string): number {
  try {
    const raw = readFileSync(trajPath, "utf8");
    const obj = JSON.parse(raw);
    const meta = obj.metadata ?? obj;
    const n = meta.total_api_calls ?? obj.info?.model_stats?.api_calls;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function sampleRateFor(eventName: string): number {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<Record<string, number>>(
    "event_sampling_config",
    {},
  );
  const rate = config[eventName];
  if (rate === undefined || rate >= 1) return 1;
  if (rate <= 0) return 0;
  return rate;
}

function rowOf(event: string, emitted: number, expected: number, sample_rate: number): CoverageRow {
  if (expected === 0) {
    return { event, emitted, expected, sample_rate, coverage: null, skipped: true };
  }
  return {
    event,
    emitted,
    expected,
    sample_rate,
    coverage: emitted / expected,
    skipped: false,
  };
}

export function computeEventCoverage(opts: { sessionLimit: number | "all" }): EventCoverageResult {
  const paths = resolvePaths();
  const refs = listSessions(paths);
  const env = sessionEnvelope(refs, opts.sessionLimit);
  const all = opts.sessionLimit === "all";
  const picked = env?.picked ?? [];
  const fromMs = all || !env ? undefined : env.fromMs;
  const toMs = all || !env ? undefined : env.toMs;

  const policyEmitted = countAnalytics("policy_enforced", fromMs, toMs);
  const policyDenom = countPolicyAuditLines(fromMs, toMs);

  const guardEmitted = countAnalytics("guardrail_triggered", fromMs, toMs);
  const sessionDirs = picked.map((r) => r.dir);
  const guardExpectedSession = countDefenseTriggers(sessionDirs);
  // `--all` 或没有会话包络时，退到 telemetry/metrics.jsonl（进程级独立信号）
  const guardExpected =
    all || picked.length === 0
      ? Math.max(guardExpectedSession, countDefenseTriggersTelemetry())
      : guardExpectedSession;

  const ctxEmitted = countAnalytics("context_assembled", fromMs, toMs);
  const apiCalls = picked.reduce((s, r) => s + readTotalApiCalls(r.trajPath), 0);
  const ctxRate = sampleRateFor("context_assembled");
  const ctxExpected = apiCalls * ctxRate;

  return {
    policy_enforced: rowOf("policy_enforced", policyEmitted, policyDenom.n, 1),
    guardrail_triggered: rowOf("guardrail_triggered", guardEmitted, guardExpected, 1),
    context_assembled: rowOf("context_assembled", ctxEmitted, ctxExpected, ctxRate),
    window: {
      source: "audit.log + telemetry/events.jsonl + session.traj",
      files: [...policyDenom.files, ...telemetryEventFiles()],
      from: env ? new Date(env.fromMs).toISOString() : null,
      to: env ? new Date(env.toMs).toISOString() : null,
      appliedTo: "all",
      all,
      sessionLimit: opts.sessionLimit,
      sessionsScanned: picked.length,
    },
    startup_timing: startupTimingStats(fromMs, toMs),
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

function fmtRow(r: CoverageRow): string {
  if (r.skipped) {
    return `  ${r.event}: 无数据，跳过（emitted=${r.emitted} expected=0）——不是 100%`;
  }
  const cov = r.coverage == null ? "—" : pct(r.emitted, r.expected);
  const warn = r.coverage != null && r.coverage > 1 ? "  ⚠ coverage>1 分母算错或重复 emit" : "";
  return `  ${r.event}: ${r.emitted}/${r.expected}  sample_rate=${r.sample_rate}  ${cov}${warn}`;
}

function main(): void {
  const { json, sessionLimit } = parseArgs(process.argv.slice(2));
  const result = computeEventCoverage({ sessionLimit });

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const L: string[] = [];
  L.push("═══ M4 三类事件覆盖率 ═══");
  const fromTo =
    result.window.from && result.window.to
      ? `${result.window.from} .. ${result.window.to}`
      : "（无会话包络）";
  L.push(
    `窗口：${fromTo}  （${result.window.all ? "--all → 全文件，不能进北极星" : `--limit ${result.window.sessionLimit} → 最近 ${result.window.sessionsScanned} 会话的时间包络`}）`,
  );
  L.push("");
  L.push(fmtRow(result.policy_enforced));
  L.push(fmtRow(result.guardrail_triggered));
  L.push(fmtRow(result.context_assembled));
  L.push("");
  if (result.startup_timing && result.startup_timing.n > 0) {
    L.push(
      `startup_timing（辅助观测，不是热路径）：n=${result.startup_timing.n} p50=${result.startup_timing.p50}ms p95=${result.startup_timing.p95}ms p99=${result.startup_timing.p99}ms`,
    );
    L.push("判读：p50 数量级变化（428→1200）才查；涨到 450 是噪声。");
  }
  L.push("");
  if (result.window.all) {
    L.push("判读：window=all，全文件口径，禁止进北极星。要用 --limit 切最近会话。");
  } else if (
    result.policy_enforced.skipped &&
    result.guardrail_triggered.skipped &&
    result.context_assembled.skipped
  ) {
    L.push("判读：三类分母都是 0。先跑一条会加载策略 / 触发护栏 / 走主循环的会话。");
  } else {
    L.push("判读：coverage ≥ 0.95 且 expected>0 才能勾出口。分母 0 不许勾。");
  }
  process.stdout.write(L.join("\n") + "\n");
}

if (import.meta.main) {
  main();
}
