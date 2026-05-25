/**
 * eval:tally — 把 baseline-w<N>-raw.json + 各 case yaml 的 baseline_scores 汇总成 markdown 报告。
 *
 * 来源: docs/eval/_archive/00-总方案.md §3.5 + _archive/07-执行顺序速查.md §2.4
 *
 * 用法:
 *   bun run eval:tally                # 默认 week=1
 *   bun run eval:tally -- --week 1    # 显式指定
 *
 * 输出:
 *   evals/_reports/baseline-w<N>.md
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import yaml from "yaml";

const ROOT = process.cwd();
const CASE_DIRS = ["evals/p0-core", "evals/p1-common", "evals/p2-edge", "evals/holdout"];
const REPORTS_DIR = "evals/_reports";

interface Case {
  id: string;
  category: string;
  priority: string;
  holdout: boolean;
  target_score: number;
  source: string;
  related_subsystem?: string[];
  baseline_scores?: {
    sid_code_w0?: { score: number | null; run_status: string; notes: string };
  };
}

interface RawRecord {
  case_id: string;
  status: string;
  duration_ms: number;
  must_include_hits: string[];
  must_include_misses: string[];
  must_not_include_violations: string[];
  transcript_path: string | null;
  error: string | null;
}

function loadCases(): Case[] {
  const out: Case[] = [];
  for (const dir of CASE_DIRS) {
    const abs = join(ROOT, dir);
    let entries: string[] = [];
    try {
      entries = readdirSync(abs).filter((f) => f.startsWith("case_") && f.endsWith(".yaml"));
    } catch {
      continue;
    }
    for (const f of entries) {
      const p = join(abs, f);
      if (!statSync(p).isFile()) continue;
      out.push(yaml.parse(readFileSync(p, "utf-8")) as Case);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { week: { type: "string", default: "1" } },
  });
  const week = String(values.week ?? "1");

  const cases = loadCases();
  const rawPath = join(ROOT, REPORTS_DIR, `baseline-w${week}-raw.json`);
  const raw = existsSync(rawPath)
    ? (JSON.parse(readFileSync(rawPath, "utf-8")) as { records: RawRecord[]; execute: boolean })
    : { records: [] as RawRecord[], execute: false };
  const rawById = new Map(raw.records.map((r) => [r.case_id, r]));

  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`# baseline-w${week}.md — sid-code 自身 baseline（${today}）`);
  lines.push("");
  lines.push(`> 生成时间: ${new Date().toISOString()}`);
  lines.push(`> 模式: ${raw.execute ? "EXECUTE（真跑）" : "DRY-RUN（未真跑）"}`);
  lines.push(`> case 总数: ${cases.length}（含 holdout）`);
  lines.push("");

  // §1 总览
  lines.push("## §1 总览");
  lines.push("");
  const grouped = {
    P0: cases.filter((c) => c.priority === "P0" && !c.holdout),
    P1: cases.filter((c) => c.priority === "P1" && !c.holdout),
    P2: cases.filter((c) => c.priority === "P2" && !c.holdout),
    holdout: cases.filter((c) => c.holdout),
  };
  lines.push("| 档位 | 数量 | 已跑 | 锚点命中率 | 平均人工分 |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const [k, group] of Object.entries(grouped)) {
    const ran = group.filter((c) => rawById.get(c.id)?.status === "success").length;
    const hits = group.reduce(
      (acc, c) => {
        const r = rawById.get(c.id);
        if (!r) return acc;
        return {
          h: acc.h + r.must_include_hits.length,
          t: acc.t + r.must_include_hits.length + r.must_include_misses.length,
        };
      },
      { h: 0, t: 0 },
    );
    const rate = hits.t > 0 ? `${((hits.h / hits.t) * 100).toFixed(0)}%` : "—";
    const scores = group
      .map((c) => c.baseline_scores?.sid_code_w0?.score)
      .filter((s): s is number => typeof s === "number");
    const avg = scores.length > 0
      ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)
      : "—";
    lines.push(`| ${k} | ${group.length} | ${ran} | ${rate} | ${avg} |`);
  }
  lines.push("");

  // §2 每条 case 详情
  lines.push("## §2 每条 case 明细（不含 holdout）");
  lines.push("");
  lines.push("| ID | Pri | 类别 | 锚点命中 | 反向违规 | 用时 | 状态 | 人工分 |");
  lines.push("|---|---|---|---:|---:|---:|---|---:|");
  for (const c of cases.filter((c) => !c.holdout)) {
    const r = rawById.get(c.id);
    const score = c.baseline_scores?.sid_code_w0?.score ?? "—";
    if (!r) {
      lines.push(`| ${c.id} | ${c.priority} | ${c.category} | — | — | — | 未跑 | ${score} |`);
      continue;
    }
    const total = r.must_include_hits.length + r.must_include_misses.length;
    const hitStr = `${r.must_include_hits.length}/${total}`;
    const violations = r.must_not_include_violations.length;
    const dur = r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—";
    lines.push(
      `| ${c.id} | ${c.priority} | ${c.category} | ${hitStr} | ${violations} | ${dur} | ${r.status} | ${score} |`,
    );
  }
  lines.push("");

  // §3 失败 / error 列表
  const failed = raw.records.filter(
    (r) => r.status === "error" || r.status === "timeout" || r.must_not_include_violations.length > 0,
  );
  lines.push("## §3 异常 / 反向违规 case");
  lines.push("");
  if (failed.length === 0) {
    lines.push("（无）");
  } else {
    for (const r of failed) {
      lines.push(`### ${r.case_id}`);
      lines.push(`- status: ${r.status}`);
      if (r.must_not_include_violations.length > 0) {
        lines.push(`- 反向违规: ${r.must_not_include_violations.join(", ")}`);
      }
      if (r.error) lines.push(`- error: \`${r.error.slice(0, 300)}\``);
      if (r.transcript_path) lines.push(`- transcript: ${r.transcript_path}`);
      lines.push("");
    }
  }
  lines.push("");

  // §4 人工评分填表入口
  lines.push("## §4 人工评分入口");
  lines.push("");
  lines.push("跑完 baseline 后，逐条打开 case yaml，按 1-5 锚点制填 `baseline_scores.sid_code_w0.score`：");
  lines.push("");
  lines.push("- 5 = 完全达成 outcome + 锚点全命中 + 输出清晰");
  lines.push("- 4 = 达成 outcome 且 ≥ 2/3 锚点命中（P0 target）");
  lines.push("- 3 = 部分达成,1/3 锚点命中（P1 target）");
  lines.push("- 2 = 方向对但有错（P2 target）");
  lines.push("- 1 = 完全偏离 / 编造");
  lines.push("- null = 跑崩 / 未跑");
  lines.push("");

  // §5 子系统覆盖
  lines.push("## §5 子系统覆盖（不含 holdout）");
  lines.push("");
  const subsystem = new Map<string, number>();
  for (const c of cases.filter((c) => !c.holdout)) {
    for (const s of c.related_subsystem ?? []) {
      subsystem.set(s, (subsystem.get(s) ?? 0) + 1);
    }
  }
  for (const [s, n] of [...subsystem.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${s}: ${n}`);
  }
  lines.push("");

  const outPath = join(ROOT, REPORTS_DIR, `baseline-w${week}.md`);
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`[OK] 写入 ${outPath}`);
}

main();
