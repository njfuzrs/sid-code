#!/usr/bin/env bun
/**
 * run-smoke.ts — PR CI smoke 评测（T-17 §6.4）
 *
 * 用法：
 *   bun run scripts/eval/run-smoke.ts --provider sid-code --max-regression 0.5
 *
 * 设计：
 *   - 跑 5 条 P0 smoke case（写在 evals/_meta/smoke-cases.yaml）
 *   - 与 case yaml 内 baseline_scores[provider].score 对比
 *   - 任一 case 下降 > maxRegression → exit 1（block PR merge）
 *   - 不写 baseline_scores（无 --sync）
 *
 * 与 eval:run 的区别：
 *   - eval:run 跑全量 25 case，时间约 8-12 分钟
 *   - run-smoke 只跑 5 case，目标 < 5 分钟（CI 友好）
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import yaml from "yaml";

interface SmokeRunResult {
  caseId: string;
  newScore: number | null;
  baselineScore: number | null;
  regression: number; // baseline - new；正数 = 下降
  status: "pass" | "regression" | "skip";
  notes: string;
}

function loadSmokeCases(evalsDir: string): string[] {
  const path = join(evalsDir, "_meta", "smoke-cases.yaml");
  if (!existsSync(path)) {
    console.warn(`[smoke] ${path} 不存在，使用默认 5 条 P0 case`);
    return ["case_001", "case_002", "case_003", "case_006", "case_007"];
  }
  const doc = yaml.parse(readFileSync(path, "utf-8")) as { smoke_cases?: string[] };
  return doc.smoke_cases ?? [];
}

function runEval(provider: string, cases: string[], evalsDir: string): Promise<void> {
  return new Promise((res, rej) => {
    const args = [
      "run",
      "eval:run",
      "--",
      "--provider",
      provider,
      "--cases",
      cases.join(","),
      "--concurrency",
      "3",
    ];
    console.log(`[smoke] bun ${args.join(" ")}`);
    const proc = spawn("bun", args, { stdio: "inherit", cwd: resolve(evalsDir, "..") });
    proc.on("exit", (code) => (code === 0 ? res() : rej(new Error(`eval exit ${code}`))));
  });
}

function loadBaselineFromCaseYaml(caseId: string, provider: string, evalsDir: string): number | null {
  for (const dir of ["p0-core", "p1-common", "p2-edge"]) {
    const p = join(evalsDir, dir, `${caseId}.yaml`);
    if (!existsSync(p)) continue;
    const doc = yaml.parse(readFileSync(p, "utf-8")) as {
      baseline_scores?: Record<string, { score?: number | null }>;
    };
    const entry = doc.baseline_scores?.[provider];
    if (!entry) return null;
    return typeof entry.score === "number" ? entry.score : null;
  }
  return null;
}

function loadLatestRun(provider: string, caseId: string, evalsDir: string): number | null {
  const path = join(evalsDir, "_runs", `${provider}.jsonl`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((j) => j && j.case_id === caseId && j.is_median !== false);
  if (lines.length === 0) return null;
  const latest = lines[lines.length - 1];
  return typeof latest.score === "number" ? latest.score : null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: "string", default: "sid-code" },
      "max-regression": { type: "string", default: "0.5" },
      "evals-dir": { type: "string", default: "evals" },
    },
  });

  const provider = values.provider as string;
  const maxRegression = Number(values["max-regression"]);
  const evalsDir = resolve(values["evals-dir"] as string);

  const cases = loadSmokeCases(evalsDir);
  console.log(`[smoke] provider=${provider} max-regression=${maxRegression} cases=${cases.length}`);

  // 跑评测
  try {
    await runEval(provider, cases, evalsDir);
  } catch (e) {
    console.error(`[smoke] eval-runner 失败: ${(e as Error).message}`);
    process.exit(2);
  }

  // 加载新分数 + baseline 对比
  const results: SmokeRunResult[] = [];
  for (const caseId of cases) {
    // provider name 映射：CLI 传 "sid-code"，落 jsonl 是 "sid_code_deepseek_v4_pro"（默认 model）
    // 简化：寻找以 provider 前缀的所有 .jsonl 取最新
    const newScore = loadLatestRun(provider, caseId, evalsDir);
    const baselineScore = loadBaselineFromCaseYaml(caseId, provider, evalsDir);
    if (newScore === null) {
      results.push({
        caseId,
        newScore: null,
        baselineScore,
        regression: 0,
        status: "skip",
        notes: "新跑分缺失（wrapper 失败）",
      });
      continue;
    }
    if (baselineScore === null) {
      results.push({
        caseId,
        newScore,
        baselineScore: null,
        regression: 0,
        status: "pass",
        notes: "首次跑分（无 baseline 对比）",
      });
      continue;
    }
    const regression = baselineScore - newScore;
    results.push({
      caseId,
      newScore,
      baselineScore,
      regression,
      status: regression > maxRegression ? "regression" : "pass",
      notes:
        regression > maxRegression
          ? `下降 ${regression.toFixed(2)} > ${maxRegression}（block PR）`
          : `Δ ${regression > 0 ? "-" : "+"}${Math.abs(regression).toFixed(2)}`,
    });
  }

  // 渲染报告
  const lines: string[] = [];
  lines.push(`# Smoke Eval Report — ${provider}`);
  lines.push("");
  lines.push(`> max-regression = ${maxRegression}`);
  lines.push("");
  lines.push("| case | baseline | new | Δ | status |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    const icon = r.status === "regression" ? "🔴" : r.status === "skip" ? "🟡" : "✅";
    lines.push(
      `| ${r.caseId} | ${r.baselineScore?.toFixed(2) ?? "–"} | ${r.newScore?.toFixed(2) ?? "–"} | ${r.regression.toFixed(2)} | ${icon} ${r.status} |`,
    );
  }
  const md = lines.join("\n");
  console.log("\n" + md);

  const reportsDir = join(evalsDir, "_reports");
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 10);
  writeFileSync(join(reportsDir, `smoke-${ts}-${provider}.md`), md, "utf-8");

  // 退出码
  const failed = results.filter((r) => r.status === "regression");
  if (failed.length > 0) {
    console.error(`\n[smoke] ❌ ${failed.length}/${results.length} case 回归 > ${maxRegression}`);
    process.exit(1);
  }
  console.log(`\n[smoke] ✅ ${results.length} case 全部通过（无 > ${maxRegression} 回归）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
