// runner.ts — 触发 Inspect AI 跑 SWE-bench Verified subset,汇总 .eval → JSON
//
// 状态：骨架（B8-1），等 S8 实施者跑通 sid_code_solver.py 后再串通
// 关联：evals/external-benchmarks/swe-bench/接入计划.md §5
//
// 用法:
//   bun run evals/external-benchmarks/swe-bench/runner.ts
//   bun run evals/external-benchmarks/swe-bench/runner.ts --limit 1   # 只跑 1 条 smoke
//
// 输出:
//   evals/external-benchmarks/swe-bench/results/inspect-{date}.eval   # Inspect 原始日志
//   _reports/external/inspect-{date}.md                                # 对人类可读的 Markdown 报告
//
// 数据隔离铁律(CLAUDE.md §0.4 + 9.3):
//   - 不写自家 baseline_scores
//   - 不进自家 grader registry
//   - 报告独立到 _reports/external/

// execSync 留给 S8 实施者跑通 sid_code_solver.py 后取消注释
// import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SWE_BENCH_DIR = resolve(__dirname);
const RESULTS_DIR = join(SWE_BENCH_DIR, "results");
const EXTERNAL_REPORT_DIR = join(REPO_ROOT, "_reports/external");
// trajectory-platform 默认按「与本仓同级的兄弟目录」定位（与 scripts/eval/paired-trajectory-diff.ts
// 的约定一致），放在别处用 SID_CODE_INSPECT_VENV 覆盖。不要写死绝对路径——那只在一台机器上成立。
const TRAJECTORY_PLATFORM_VENV =
  process.env.SID_CODE_INSPECT_VENV ?? resolve(REPO_ROOT, "../trajectory-platform/backend/venv");

function parseArgs(argv: string[]): { limit?: number; model: string } {
  let limit: number | undefined;
  let model = "anthropic/claude-sonnet-4-6";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      limit = Number(argv[++i]);
    } else if (arg === "--model") {
      model = argv[++i];
    }
  }
  return { limit, model };
}

function ensureDirs() {
  for (const dir of [RESULTS_DIR, EXTERNAL_REPORT_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function todayIso(): string {
  // 静态 ISO 日期(本路线规约:不依赖运行时 Date,跑分时由实施者从 inspect log 文件名取)
  // 实际由 S8 实施者跑 `date +%Y-%m-%d` 后传 --date 覆盖
  return process.env.SID_CODE_REPORT_DATE ?? "TODO";
}

function buildInspectCommand(opts: { limit?: number; model: string; logDir: string }) {
  const limitFlag = opts.limit ? `--limit ${opts.limit}` : "";
  return [
    `source ${TRAJECTORY_PLATFORM_VENV}/bin/activate`,
    `cd ${REPO_ROOT}`,
    `inspect eval evals/external-benchmarks/swe-bench/sid_code_solver.py:swe_bench_sid_code`,
    `  --model ${opts.model}`,
    `  --log-dir ${opts.logDir}`,
    `  ${limitFlag}`,
  ].join(" \\\n");
}

interface RunSummary {
  model: string;
  limit: number | undefined;
  pass_at_1: number; // 命中 / 总数
  avg_steps: number | null;
  avg_tools: number | null;
  per_instance: Array<{
    instance_id: string;
    pass: boolean;
    steps: number | null;
    tools: number | null;
    duration_s: number | null;
    notes: string;
  }>;
}

function summariseEvalLog(_logDir: string): RunSummary {
  // ⚠ 骨架占位:Inspect EvalLog 是 zip 压缩的 JSON
  // S8 实施者用 inspect_ai.log.read_eval_log 读取 _logDir,或用 `inspect log dump` 命令转 JSON
  // 这里返回 placeholder,跑通后再实现
  return {
    model: "TODO",
    limit: undefined,
    pass_at_1: 0,
    avg_steps: null,
    avg_tools: null,
    per_instance: [],
  };
}

function renderMarkdown(summary: RunSummary, date: string): string {
  const lines: string[] = [];
  lines.push(`# SWE-bench Verified subset — Inspect AI 跑分报告`);
  lines.push("");
  lines.push(`> 生成日期: ${date}`);
  lines.push(`> 模型: ${summary.model}`);
  lines.push(`> 跑数量: ${summary.limit ?? "10"} / 10`);
  lines.push(`> 数据源: SWE-bench Verified（subset，B8-2 精挑）`);
  lines.push(`> 不写自家 baseline_scores（数据隔离铁律）`);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push(`- **pass@1**: ${(summary.pass_at_1 * 100).toFixed(1)}%`);
  lines.push(`- **平均步数**: ${summary.avg_steps ?? "—"}`);
  lines.push(`- **平均工具调用**: ${summary.avg_tools ?? "—"}`);
  lines.push("");
  lines.push("## 每条 instance");
  lines.push("");
  lines.push("| instance_id | pass | steps | tools | duration_s | 备注 |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- |");
  for (const r of summary.per_instance) {
    lines.push(
      `| ${r.instance_id} | ${r.pass ? "✅" : "❌"} | ${r.steps ?? "—"} | ${r.tools ?? "—"} | ${r.duration_s ?? "—"} | ${r.notes} |`,
    );
  }
  lines.push("");
  lines.push("## 与自家分数对照");
  lines.push("");
  lines.push("> 见 `_reports/external/self-vs-external-{date}.md`（B8-5 自动生成）");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDirs();
  const date = todayIso();
  const logDir = join(RESULTS_DIR, `inspect-${date}`);
  mkdirSync(logDir, { recursive: true });

  const cmd = buildInspectCommand({ ...args, logDir });
  console.log("[swe-bench/runner] Inspect 命令:\n" + cmd);
  console.log("\n⚠ 骨架占位:S8 实施者跑通 sid_code_solver.py 后取消下方 execSync 注释");

  // execSync(cmd, { stdio: "inherit", shell: "/bin/bash" });

  const summary = summariseEvalLog(logDir);
  const report = renderMarkdown(summary, date);
  const reportPath = join(EXTERNAL_REPORT_DIR, `inspect-${date}.md`);
  writeFileSync(reportPath, report, "utf-8");
  console.log(`\n[swe-bench/runner] 报告已落: ${reportPath}`);
}

if (import.meta.main) {
  main();
}
