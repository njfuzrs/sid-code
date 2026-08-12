#!/usr/bin/env bun
/**
 * check-external-anchor-due.ts —— B7-8 §15.4 蒸馏护栏 3 入口
 *
 * 用途：
 *   季度跑外部 paired comparison（GitHub Top 100 随机抽 10 条 / SWE-bench Verified subset / CR 标准化样本）。
 *   本脚本**不真跑**，仅做状态追踪 + 到期判定 —— 真跑工作流见 §15.1 双轨外部锚 spec。
 *
 * 状态文件：
 *   `_reports/external/anchor-runs.jsonl`
 *   每行一条：{ run_at: ISO8601, track: "execution"|"report", subset: <name>, summary_path: <path>, sprint: <S?> }
 *
 * 判定规则（§15.4 v1.3 第 3 条护栏）：
 *   - 90 天内有 ≥ 1 条 execution 轨记录 ∧ ≥ 1 条 report 轨记录 → due=false（护栏 satisfied）
 *   - 90 天内只有一轨 → due=partial（warning，给出缺失轨）
 *   - 90 天内无任何记录 → due=true（reject Sprint 末毕业判定）
 *
 * 退出码：
 *   0 = satisfied（绿灯）
 *   1 = due（红灯：到期未跑或部分缺失，Sprint 末毕业判定 § 7.4 应阻塞）
 *   2 = 用法错误
 *
 * 用法：
 *   # 检查到期状态
 *   bun run scripts/eval/check-external-anchor-due.ts
 *
 *   # 记录一次刚跑完的外部锚
 *   bun run scripts/eval/check-external-anchor-due.ts \
 *     --record --track execution --subset swe-bench-verified-10 \
 *     --summary _reports/external/swe-bench-2026-Q2.md
 *
 *   # 自定义"季度"窗口（默认 90 天）
 *   bun run scripts/eval/check-external-anchor-due.ts --window-days 60
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SID_CODE_ROOT = resolve(import.meta.dir, "..", "..");
const STATE_PATH = join(SID_CODE_ROOT, "_reports", "external", "anchor-runs.jsonl");
const DEFAULT_WINDOW_DAYS = 90;

export type AnchorTrack = "execution" | "report";

export interface AnchorRunRecord {
  run_at: string; // ISO8601 with timezone
  track: AnchorTrack;
  subset: string; // e.g. "swe-bench-verified-10"
  summary_path?: string; // markdown report path
  sprint?: string; // "S7" / "S8"
}

export type AnchorStatus = "satisfied" | "partial" | "due";

export interface AnchorReport {
  status: AnchorStatus;
  window_days: number;
  cutoff_iso: string;
  execution_count: number;
  report_count: number;
  most_recent_execution?: AnchorRunRecord;
  most_recent_report?: AnchorRunRecord;
  missing_tracks: AnchorTrack[];
}

interface CliArgs {
  mode: "check" | "record";
  windowDays: number;
  // record-only
  track?: AnchorTrack;
  subset?: string;
  summary?: string;
  sprint?: string;
  // check-only
  now?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "check", windowDays: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--record") args.mode = "record";
    else if (a === "--track") args.track = argv[++i] as AnchorTrack;
    else if (a === "--subset") args.subset = argv[++i];
    else if (a === "--summary") args.summary = argv[++i];
    else if (a === "--sprint") args.sprint = argv[++i];
    else if (a === "--window-days") args.windowDays = Number(argv[++i] ?? DEFAULT_WINDOW_DAYS);
    else if (a === "--now") args.now = argv[++i];
  }
  return args;
}

export function loadRuns(statePath: string = STATE_PATH): AnchorRunRecord[] {
  if (!existsSync(statePath)) return [];
  const text = readFileSync(statePath, "utf-8");
  const out: AnchorRunRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as AnchorRunRecord;
      if (
        obj &&
        typeof obj.run_at === "string" &&
        (obj.track === "execution" || obj.track === "report")
      ) {
        out.push(obj);
      }
    } catch {
      // skip malformed line（不阻塞，便于 hot fix 状态文件）
    }
  }
  return out;
}

export function recordRun(rec: AnchorRunRecord, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  appendFileSync(statePath, JSON.stringify(rec) + "\n", "utf-8");
}

/**
 * 给定 runs + window，判定护栏状态。
 *
 * 双轨设计来自 §15.1：execution 轨和 report 轨**独立计数**，缺一个就是 partial。
 */
export function evaluateStatus(
  runs: AnchorRunRecord[],
  windowDays: number = DEFAULT_WINDOW_DAYS,
  nowIso?: string,
): AnchorReport {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  if (!Number.isFinite(now)) {
    throw new Error(`invalid nowIso: ${nowIso}`);
  }
  const cutoff = now - windowDays * 24 * 3600 * 1000;
  const cutoffIso = new Date(cutoff).toISOString();

  const inWindow = runs.filter((r) => {
    const t = Date.parse(r.run_at);
    return Number.isFinite(t) && t >= cutoff && t <= now;
  });

  const exec = inWindow
    .filter((r) => r.track === "execution")
    .sort((a, b) => Date.parse(b.run_at) - Date.parse(a.run_at));
  const report = inWindow
    .filter((r) => r.track === "report")
    .sort((a, b) => Date.parse(b.run_at) - Date.parse(a.run_at));

  const missing: AnchorTrack[] = [];
  if (exec.length === 0) missing.push("execution");
  if (report.length === 0) missing.push("report");

  let status: AnchorStatus;
  if (missing.length === 0) status = "satisfied";
  else if (missing.length === 2) status = "due";
  else status = "partial";

  return {
    status,
    window_days: windowDays,
    cutoff_iso: cutoffIso,
    execution_count: exec.length,
    report_count: report.length,
    most_recent_execution: exec[0],
    most_recent_report: report[0],
    missing_tracks: missing,
  };
}

function renderReport(rep: AnchorReport): string {
  const lines: string[] = [];
  lines.push("[external-anchor-due] 状态：" + rep.status.toUpperCase());
  lines.push(`  窗口      = ${rep.window_days} 天（cutoff = ${rep.cutoff_iso}）`);
  lines.push(
    `  execution 轨命中 ${rep.execution_count} 次` +
      (rep.most_recent_execution
        ? `（最近 ${rep.most_recent_execution.run_at} / subset=${rep.most_recent_execution.subset}）`
        : ""),
  );
  lines.push(
    `  report 轨命中 ${rep.report_count} 次` +
      (rep.most_recent_report
        ? `（最近 ${rep.most_recent_report.run_at} / subset=${rep.most_recent_report.subset}）`
        : ""),
  );
  if (rep.missing_tracks.length > 0) {
    lines.push(`  缺失轨    = ${rep.missing_tracks.join(", ")}`);
  }
  if (rep.status !== "satisfied") {
    lines.push("");
    lines.push("§15.4 v1.3 第 3 条护栏：季度跑外部 paired comparison（双轨独立计数）");
    lines.push("Sprint 末毕业判定 §7.4 要求 both-tracks-within-window；当前未满足，应阻塞");
    lines.push("跑完后用：");
    lines.push("  bun run scripts/eval/check-external-anchor-due.ts \\");
    lines.push("    --record --track <execution|report> --subset <name> --summary <md path>");
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const args = parseArgs(argv.slice(2));

  if (args.mode === "record") {
    if (!args.track || !args.subset) {
      console.error(
        "[external-anchor] usage: --record --track <execution|report> --subset <name> [--summary <path>] [--sprint <S?>]",
      );
      return 2;
    }
    if (args.track !== "execution" && args.track !== "report") {
      console.error(`[external-anchor] --track must be execution or report, got: ${args.track}`);
      return 2;
    }
    const rec: AnchorRunRecord = {
      run_at: new Date().toISOString(),
      track: args.track,
      subset: args.subset,
      summary_path: args.summary,
      sprint: args.sprint,
    };
    recordRun(rec);
    console.log(`[external-anchor] ✅ recorded: ${JSON.stringify(rec)}`);
    return 0;
  }

  // check 模式
  const runs = loadRuns();
  const rep = evaluateStatus(runs, args.windowDays, args.now);
  console.log(renderReport(rep));

  switch (rep.status) {
    case "satisfied":
      return 0;
    case "partial":
    case "due":
    default:
      return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv));
}

export { main, parseArgs, renderReport };
