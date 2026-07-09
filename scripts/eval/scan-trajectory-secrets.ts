#!/usr/bin/env bun
/**
 * scan-trajectory-secrets.ts —— B6-4 批量脱敏二审扫描器
 *
 * 用途：
 *   批量扫 trajectory-platform/bench/tasks/<id>/task.yaml，复用 lib/security-scan.ts scanSecrets/scanContamination
 *   输出报告：哪些 task 命中 private_key / api_key / email / ip / contamination
 *   标注：unsafe_for_holdout（任何 secret 命中或 ≥ 1 contamination）/ needs_sanitization（仅 email/ip）/ safe
 *
 * 用法：
 *   # 扫全部 splits
 *   bun run scripts/eval/scan-trajectory-secrets.ts
 *
 *   # 只扫指定 split
 *   bun run scripts/eval/scan-trajectory-secrets.ts --split holdout
 *
 *   # 自定义 trajectory-platform 根
 *   bun run scripts/eval/scan-trajectory-secrets.ts --root /path/to/trajectory-platform
 *
 * 输出：
 *   stdout: 每个 task 一行 status + 命中数；末尾按 split 汇总
 *   报告：sid-code/_reports/bench-secrets-audit.md（markdown 表格 + 详细命中清单）
 *
 * 退出码：
 *   0 = clean（全部 safe）
 *   1 = 有 unsafe / needs_sanitization 命中（CI 信号）
 *   2 = 用法错误
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanSecrets, scanContamination } from "./lib/security-scan.ts";

const SID_CODE_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_BENCH_ROOT = resolve(SID_CODE_ROOT, "..", "trajectory-platform");
const DEFAULT_SPLITS = ["capability", "holdout", "regression", "smoke"] as const;

type ScanStatus = "safe" | "needs_sanitization" | "unsafe_for_holdout";

interface TaskScanResult {
  task_id: string;
  split: string;
  status: ScanStatus;
  contamination_hits: string[];
  secret_hits: { kind: string; match: string }[];
}

interface CliArgs {
  benchRoot: string;
  splits: string[];
}

function parseArgs(argv: string[]): CliArgs {
  let benchRoot = DEFAULT_BENCH_ROOT;
  let splits: string[] = [...DEFAULT_SPLITS];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      benchRoot = resolve(argv[++i] ?? "");
    } else if (a === "--split") {
      splits = [argv[++i] ?? ""];
    }
  }
  return { benchRoot, splits };
}

function loadSplitTaskIds(benchRoot: string, split: string): string[] {
  const splitFile = join(benchRoot, "bench", "splits", `${split}.txt`);
  if (!existsSync(splitFile)) return [];
  const lines = readFileSync(splitFile, "utf-8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
  // holdout.txt 用 trajectory sid（uuid）而非 task_id（T0xxx），与 bench/tasks/<task_id>/ 不同名。
  // 仅保留 T 开头的合法 task_id；非 task_id 行返回空（在 main 里用警告标出）。
  return lines.filter((s) => /^T\d+$/.test(s));
}

function classifyHits(
  contamination: string[],
  secrets: { kind: string; match: string }[],
): ScanStatus {
  // 任何 contamination 命中 → unsafe_for_holdout（结构性问题）
  if (contamination.length > 0) return "unsafe_for_holdout";

  // 强 secret 命中 → unsafe_for_holdout
  const hardKinds = new Set(["private_key", "api_key"]);
  if (secrets.some((s) => hardKinds.has(s.kind))) return "unsafe_for_holdout";

  // email/ip 命中 → 仅需脱敏（多数是 trace 里普通邮件 / 内网 IP）
  if (secrets.length > 0) return "needs_sanitization";

  return "safe";
}

function scanTask(benchRoot: string, taskId: string, split: string): TaskScanResult | null {
  const taskFile = join(benchRoot, "bench", "tasks", taskId, "task.yaml");
  if (!existsSync(taskFile)) return null;

  let text: string;
  try {
    text = readFileSync(taskFile, "utf-8");
  } catch {
    return null;
  }

  const contamination = scanContamination(text);
  const secrets = scanSecrets(text);
  return {
    task_id: taskId,
    split,
    status: classifyHits(contamination, secrets),
    contamination_hits: contamination,
    secret_hits: secrets,
  };
}

function renderReport(results: TaskScanResult[]): string {
  const bySplit = new Map<string, TaskScanResult[]>();
  for (const r of results) {
    if (!bySplit.has(r.split)) bySplit.set(r.split, []);
    bySplit.get(r.split)!.push(r);
  }

  const lines: string[] = [];
  lines.push("# Trajectory-platform bench 脱敏二审报告（B6-4）");
  lines.push("");
  lines.push(`> 扫描时间：${new Date().toISOString()}`);
  lines.push("> 扫描器：`scripts/eval/scan-trajectory-secrets.ts`（复用 importer scanSecrets / scanContamination）");
  lines.push(">");
  lines.push("> **判定规则**：");
  lines.push("> - `unsafe_for_holdout`：命中 contamination（tool_result_content 等）或强 secret（private_key / api_key）—— 严禁进 holdout");
  lines.push("> - `needs_sanitization`：命中 email / ip —— 可进 capability/regression，但 holdout 前需脱敏");
  lines.push("> - `safe`：无任何命中");
  lines.push("");

  // 总览
  lines.push("## 1. 各 split 总览");
  lines.push("");
  lines.push("| split | total | safe | needs_sanitization | unsafe_for_holdout |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const split of [...bySplit.keys()].sort()) {
    const list = bySplit.get(split)!;
    const safe = list.filter((r) => r.status === "safe").length;
    const sanit = list.filter((r) => r.status === "needs_sanitization").length;
    const unsafe = list.filter((r) => r.status === "unsafe_for_holdout").length;
    lines.push(`| ${split} | ${list.length} | ${safe} | ${sanit} | ${unsafe} |`);
  }
  lines.push("");

  // unsafe / needs_sanitization 详情
  lines.push("## 2. unsafe_for_holdout 详情（必须修或剔除）");
  lines.push("");
  const unsafeList = results.filter((r) => r.status === "unsafe_for_holdout");
  if (unsafeList.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| task_id | split | contamination | secret_kinds |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of unsafeList) {
      const kinds = [...new Set(r.secret_hits.map((s) => s.kind))].join(",") || "-";
      const cont = r.contamination_hits.length > 0 ? `${r.contamination_hits.length} hit(s)` : "-";
      lines.push(`| ${r.task_id} | ${r.split} | ${cont} | ${kinds} |`);
    }
  }
  lines.push("");

  lines.push("## 3. needs_sanitization 详情（capability/regression OK，holdout 前需脱敏）");
  lines.push("");
  const sanitList = results.filter((r) => r.status === "needs_sanitization");
  if (sanitList.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| task_id | split | secret_kinds | sample (前 1 条) |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of sanitList.slice(0, 200)) {
      const kinds = [...new Set(r.secret_hits.map((s) => s.kind))].join(",");
      const sample = (r.secret_hits[0]?.match ?? "").replace(/\|/g, "\\|").slice(0, 80);
      lines.push(`| ${r.task_id} | ${r.split} | ${kinds} | \`${sample}\` |`);
    }
    if (sanitList.length > 200) {
      lines.push("");
      lines.push(`（仅展示前 200 条，剩余 ${sanitList.length - 200} 条略）`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function runScan(args: CliArgs): { results: TaskScanResult[]; report: string } {
  const results: TaskScanResult[] = [];
  for (const split of args.splits) {
    const ids = loadSplitTaskIds(args.benchRoot, split);
    for (const id of ids) {
      const r = scanTask(args.benchRoot, id, split);
      if (r) results.push(r);
    }
  }
  return { results, report: renderReport(results) };
}

function main(argv: string[]): number {
  const args = parseArgs(argv.slice(2));

  if (!existsSync(args.benchRoot)) {
    console.error(`[scan] ❌ trajectory-platform root not found: ${args.benchRoot}`);
    console.error(`        pass --root <path> to override (default: ${DEFAULT_BENCH_ROOT})`);
    return 2;
  }

  // 简单 sanity：bench/tasks/ 必须存在
  const tasksDir = join(args.benchRoot, "bench", "tasks");
  if (!existsSync(tasksDir) || !statSync(tasksDir).isDirectory()) {
    console.error(`[scan] ❌ ${tasksDir} not found / not a dir`);
    return 2;
  }

  console.log(`[scan] root=${args.benchRoot}  splits=${args.splits.join(",")}`);
  const { results, report } = runScan(args);

  // 各 split 行数 vs 实际扫到 task.yaml 数对账（holdout 用 sid 不是 task_id，必然 0/200，不是 bug）
  for (const split of args.splits) {
    const splitFile = join(args.benchRoot, "bench", "splits", `${split}.txt`);
    if (!existsSync(splitFile)) continue;
    const totalLines = readFileSync(splitFile, "utf-8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;
    const scanned = results.filter((r) => r.split === split).length;
    if (scanned < totalLines) {
      console.log(
        `[scan]   ⚠️  ${split}: split.txt ${totalLines} 行 → 扫到 ${scanned} task；剩余 ${totalLines - scanned} 行非 T 开头（多为 trajectory sid，不对应 task.yaml）`,
      );
    }
  }

  if (results.length === 0) {
    console.error(`[scan] ⚠️  no task scanned; check splits exist`);
    return 2;
  }

  // 落报告
  const reportDir = join(SID_CODE_ROOT, "_reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, "bench-secrets-audit.md");
  writeFileSync(reportPath, report, "utf-8");
  console.log(`[scan] 报告已落: ${reportPath}`);

  // stdout 简表
  const safe = results.filter((r) => r.status === "safe").length;
  const sanit = results.filter((r) => r.status === "needs_sanitization").length;
  const unsafe = results.filter((r) => r.status === "unsafe_for_holdout").length;
  console.log(`[scan] 总计 ${results.length}: safe=${safe} / needs_sanitization=${sanit} / unsafe_for_holdout=${unsafe}`);

  if (unsafe > 0 || sanit > 0) return 1;
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}

export { main, scanTask, classifyHits, loadSplitTaskIds, renderReport };
export type { TaskScanResult, ScanStatus };
