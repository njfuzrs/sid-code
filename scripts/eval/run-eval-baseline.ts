/**
 * eval:baseline — 跑 sid-code 自身 baseline（W1 默认 dry-run，需 --execute 才真跑）。
 *
 * 来源: docs/eval/_archive/00-总方案.md §3.5 + _archive/07-执行顺序速查.md §2.4
 *
 * 模式:
 *   默认 dry-run        : 列出每条 case 的计划（不调用 LLM）
 *   --execute           : 实际调用 sid-code 跑（每条 ~5-30s, 25 条 ~5-15min, 成本 $1-3）
 *   --execute --case ID : 只跑指定 case（调试用）
 *
 * 用法:
 *   bun run eval:baseline                              # dry-run, 全部
 *   bun run eval:baseline -- --skip-holdout            # dry-run, 排除 holdout
 *   bun run eval:baseline -- --execute --skip-holdout  # 真跑 20 条
 *   bun run eval:baseline -- --execute --case case_001 # 真跑 1 条调试
 *
 * 输出:
 *   evals/raw-outputs/<case_id>_<ts>.jsonl    — transcript（每跑 1 条 1 文件）
 *   evals/_reports/baseline-w<N>-raw.json     — 汇总 raw 数据
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import yaml from "yaml";

const ROOT = process.cwd();
const CASE_DIRS = ["evals/general/p0-core", "evals/general/p1-common", "evals/general/p2-edge", "evals/holdout"];
const RAW_DIR = "evals/raw-outputs";
const REPORTS_DIR = "evals/_reports";

interface Case {
  id: string;
  category: string;
  priority: string;
  holdout: boolean;
  target_score: number;
  input: { user_query: string; repo: string; repo_commit: string };
  expected: {
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    must_not_call_tools?: string[];
    max_steps?: number;
  };
  related_subsystem?: string[];
  source: string;
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
      const data = yaml.parse(readFileSync(p, "utf-8")) as Case;
      out.push(data);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

interface RunRecord {
  case_id: string;
  priority: string;
  category: string;
  status: "pending" | "success" | "error" | "timeout" | "dry-run";
  duration_ms: number;
  output_chars: number;
  must_include_hits: string[];
  must_include_misses: string[];
  must_not_include_violations: string[];
  transcript_path: string | null;
  error: string | null;
  started_at: string;
  ended_at: string;
}

function checkAnchors(output: string, expected: Case["expected"]): {
  hits: string[];
  misses: string[];
  violations: string[];
} {
  const includes = expected.must_include_any_of ?? [];
  const excludes = expected.must_not_include ?? [];
  const lower = output.toLowerCase();
  const hits = includes.filter((kw) => lower.includes(kw.toLowerCase()));
  const misses = includes.filter((kw) => !lower.includes(kw.toLowerCase()));
  const violations = excludes.filter((kw) => kw && lower.includes(kw.toLowerCase()));
  return { hits, misses, violations };
}

async function runCase(c: Case, timeoutMs: number): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const transcriptPath = join(
    ROOT,
    RAW_DIR,
    `${c.id}_${Date.now()}.jsonl`,
  );

  const env = {
    ...process.env,
    SID_CODE_NO_TELEMETRY: "1",
    SID_CODE_EVAL_MODE: "1",
  };

  const args = [
    "run", "src/entrypoints/bootstrap.ts",
    "--print",
    "--output-format", "json",
    "--max-turns", String(c.expected.max_steps ?? 15),
    "--permission-mode", "default",
    c.input.user_query,
  ];

  return new Promise<RunRecord>((resolve) => {
    const proc = spawn("bun", args, { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      const t1 = Date.now();
      const endedAt = new Date().toISOString();

      try {
        writeFileSync(transcriptPath, JSON.stringify({
          case_id: c.id,
          started_at: startedAt,
          ended_at: endedAt,
          duration_ms: t1 - t0,
          exit_code: code,
          stdout,
          stderr,
        }) + "\n", "utf-8");
      } catch {
        /* ignore — 不阻塞 */
      }

      const status: RunRecord["status"] =
        code === 0 ? "success" : code === null ? "timeout" : "error";
      const { hits, misses, violations } = checkAnchors(stdout, c.expected);
      resolve({
        case_id: c.id,
        priority: c.priority,
        category: c.category,
        status,
        duration_ms: t1 - t0,
        output_chars: stdout.length,
        must_include_hits: hits,
        must_include_misses: misses,
        must_not_include_violations: violations,
        transcript_path: transcriptPath,
        error: status === "success" ? null : stderr.slice(-500),
        started_at: startedAt,
        ended_at: endedAt,
      });
    });
  });
}

function dryRunRecord(c: Case): RunRecord {
  return {
    case_id: c.id,
    priority: c.priority,
    category: c.category,
    status: "dry-run",
    duration_ms: 0,
    output_chars: 0,
    must_include_hits: [],
    must_include_misses: c.expected.must_include_any_of ?? [],
    must_not_include_violations: [],
    transcript_path: null,
    error: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      execute: { type: "boolean" },
      "skip-holdout": { type: "boolean" },
      case: { type: "string" },
      priority: { type: "string", multiple: true },
      timeout: { type: "string" },
      week: { type: "string", default: "1" },
    },
  });

  const execute = Boolean(values.execute);
  const skipHoldout = Boolean(values["skip-holdout"]);
  const onlyCase = values.case as string | undefined;
  const priorityFilter = values.priority as string[] | undefined;
  const timeoutMs = Number(values.timeout ?? 300_000);
  const week = String(values.week ?? "1");

  let cases = loadCases();
  if (skipHoldout) cases = cases.filter((c) => !c.holdout);
  if (priorityFilter && priorityFilter.length > 0) {
    cases = cases.filter((c) => priorityFilter.includes(c.priority));
  }
  if (onlyCase) cases = cases.filter((c) => c.id === onlyCase);

  console.log(`# eval:baseline ${execute ? "(EXECUTE)" : "(dry-run)"} — ${cases.length} cases`);
  if (skipHoldout) console.log("# skip-holdout=on");
  if (onlyCase) console.log(`# only case=${onlyCase}`);
  console.log();

  mkdirSync(join(ROOT, RAW_DIR), { recursive: true });
  mkdirSync(join(ROOT, REPORTS_DIR), { recursive: true });

  const records: RunRecord[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const tag = `[${i + 1}/${cases.length}] ${c.id} (${c.priority})`;
    if (!execute) {
      console.log(`${tag} — dry-run`);
      console.log(`     query: ${c.input.user_query.slice(0, 120).replace(/\s+/g, " ")}…`);
      console.log(`     anchors: ${(c.expected.must_include_any_of ?? []).slice(0, 3).join(", ")}`);
      records.push(dryRunRecord(c));
      continue;
    }
    process.stdout.write(`${tag} — running… `);
    const rec = await runCase(c, timeoutMs);
    console.log(
      `${rec.status} (${(rec.duration_ms / 1000).toFixed(1)}s, ` +
        `hits=${rec.must_include_hits.length}/${(c.expected.must_include_any_of ?? []).length})`,
    );
    records.push(rec);
  }

  const reportPath = join(ROOT, REPORTS_DIR, `baseline-w${week}-raw.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        week,
        generated_at: new Date().toISOString(),
        execute,
        total: records.length,
        success: records.filter((r) => r.status === "success").length,
        error: records.filter((r) => r.status === "error" || r.status === "timeout").length,
        records,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log();
  console.log(`[OK] 写入 ${reportPath}`);
  if (!execute) {
    console.log("[INFO] 这是 dry-run。要真跑请加 --execute");
  } else {
    console.log("[NEXT] 跑 bun run eval:tally -- --week " + week + " 生成报告");
    console.log("[NEXT] 手动给每条 case 在 yaml 里填 baseline_scores.sid_code_w0.score (1-5)");
  }
}

await main();
