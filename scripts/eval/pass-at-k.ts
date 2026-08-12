#!/usr/bin/env bun
/**
 * pass-at-k.ts — 计算 Pass@1 / Pass@3 / Pass^3 三层指标（T-15）
 *
 * 设计依据：docs/eval/investigations/eval-rubric-industry-survey.md §6.4 T-15
 * 业界对齐：SWE Atlas "Pass@3 (capability), Pass@1 (expected), Pass^3 (consistency)"
 *
 * 数据源：evals/_runs/{provider}.jsonl 中 is_median=false 的 raw samples 行
 *   - 每条 critical case 跑 --samples=3 时会写 3 行 raw samples
 *   - sample_index 0/1/2 标识第几次
 *
 * 指标计算（pass = score >= 通过线 2.5/5）：
 *   - Pass@1 = avg(score across 3 samples)
 *   - Pass@3 = max(pass across 3 samples)，至少 1 次 pass 即为 1
 *   - Pass^3 = AND(pass across 3 samples)，3 次都 pass 才为 1
 *
 * 输出：
 *   - 控制台表格
 *   - evals/_reports/pass-at-k-{provider}.md
 *
 * 用法：
 *   bun run scripts/eval/pass-at-k.ts --provider sid-code-deepseek-v4-pro
 *   bun run scripts/eval/pass-at-k.ts --provider sid-code-deepseek-v4-pro --threshold 3.5
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import yaml from "yaml";

const PASS_THRESHOLD = 2.5; // baseline 通过线（5 分制）
const STABILITY_RATIO = 0.7; // Pass^3/Pass@3 ≥ 0.7 视为稳定

interface RunRecord {
  run_id?: string;
  case_id: string;
  provider: string;
  score: number | null;
  is_median?: boolean;
  sample_index?: number;
  tested_at?: string;
}

interface CaseStats {
  caseId: string;
  samples: number[]; // 3 次原始分（null 当 0 处理）
  passAt1: number; // 平均分（5 分制）
  passAt3: number; // 0/1
  passPow3: number; // 0/1
  stable: boolean; // Pass^3/Pass@3 >= STABILITY_RATIO
}

function loadCriticalCases(evalsDir: string): { id: string; category: string }[] {
  const path = join(evalsDir, "_meta", "critical-cases.yaml");
  if (!existsSync(path)) return [];
  const doc = yaml.parse(readFileSync(path, "utf-8")) as {
    critical_cases?: { id: string; category: string }[];
  };
  return doc.critical_cases ?? [];
}

function loadRunSamples(evalsDir: string, provider: string): Map<string, RunRecord[]> {
  const path = join(evalsDir, "_runs", `${provider}.jsonl`);
  const byCase = new Map<string, RunRecord[]>();
  if (!existsSync(path)) {
    console.warn(`[pass-at-k] 无运行历史: ${path}`);
    return byCase;
  }
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as RunRecord;
      if (r.is_median !== false) continue; // 仅取 raw samples
      if (!byCase.has(r.case_id)) byCase.set(r.case_id, []);
      byCase.get(r.case_id)!.push(r);
    } catch {
      /* skip */
    }
  }
  return byCase;
}

function computePassAtK(samples: RunRecord[], threshold: number): CaseStats {
  // 取最近 3 次（按 sample_index 或 tested_at 排序）
  const sorted = [...samples].sort((a, b) => {
    const ai = a.sample_index ?? 0;
    const bi = b.sample_index ?? 0;
    return ai - bi;
  });
  const last3 = sorted.slice(-3).map((s) => (typeof s.score === "number" ? s.score : 0));

  const passes = last3.map((s) => (s >= threshold ? 1 : 0));
  const passAt1 = last3.length > 0 ? last3.reduce((a, b) => a + b, 0) / last3.length : 0;
  const passAt3 = passes.some((p) => p === 1) ? 1 : 0;
  const passPow3 = passes.length === 3 && passes.every((p) => p === 1) ? 1 : 0;
  const stable = passAt3 > 0 ? passPow3 / passAt3 >= STABILITY_RATIO : false;

  return {
    caseId: samples[0]?.case_id ?? "?",
    samples: last3,
    passAt1: Number(passAt1.toFixed(2)),
    passAt3,
    passPow3,
    stable,
  };
}

function renderReport(provider: string, stats: CaseStats[], threshold: number): string {
  const lines: string[] = [];
  lines.push(`# Pass@1 / Pass@3 / Pass^3 — ${provider}`);
  lines.push("");
  lines.push(`> 通过线: score ≥ ${threshold}（5 分制）`);
  lines.push(`> 稳定性: Pass^3/Pass@3 ≥ ${STABILITY_RATIO} = 稳定`);
  lines.push("");
  lines.push("## 三层指标对照表");
  lines.push("");
  lines.push("| case | samples (3 次原始分) | Pass@1 (avg) | Pass@3 | Pass^3 | 稳定 |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of stats) {
    const samplesStr = s.samples.map((n) => n.toFixed(1)).join(" / ");
    lines.push(
      `| ${s.caseId} | ${samplesStr} | ${s.passAt1.toFixed(2)} | ${s.passAt3} | ${s.passPow3} | ${s.stable ? "✅" : "🟡"} |`,
    );
  }
  lines.push("");
  // 总结
  const totalCases = stats.length;
  const stableCases = stats.filter((s) => s.stable).length;
  const avgPassAt1 = stats.length > 0 ? stats.reduce((a, b) => a + b.passAt1, 0) / stats.length : 0;
  const avgPassAt3 = stats.length > 0 ? stats.reduce((a, b) => a + b.passAt3, 0) / stats.length : 0;
  const avgPassPow3 =
    stats.length > 0 ? stats.reduce((a, b) => a + b.passPow3, 0) / stats.length : 0;
  lines.push("## 汇总");
  lines.push("");
  lines.push(`- 评测 case 数: ${totalCases}`);
  lines.push(`- 稳定 case: ${stableCases}/${totalCases}`);
  lines.push(`- Pass@1 均值: ${avgPassAt1.toFixed(2)}`);
  lines.push(`- Pass@3 比例: ${avgPassAt3.toFixed(2)}`);
  lines.push(`- Pass^3 比例: ${avgPassPow3.toFixed(2)}`);
  lines.push(`- 稳定性 spread: ${(avgPassAt3 - avgPassPow3).toFixed(2)}（理想 ≤ 0.2）`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: "string" },
      threshold: { type: "string", default: String(PASS_THRESHOLD) },
      "evals-dir": { type: "string", default: "evals" },
      output: { type: "string" },
    },
  });

  if (!values.provider) {
    console.error("用法: bun run scripts/eval/pass-at-k.ts --provider <name>");
    console.error("可用 provider:");
    const evalsDir = resolve(values["evals-dir"] as string);
    const runsDir = join(evalsDir, "_runs");
    if (existsSync(runsDir)) {
      for (const f of readdirSync(runsDir)) {
        if (f.endsWith(".jsonl")) console.error(`  - ${f.slice(0, -".jsonl".length)}`);
      }
    }
    process.exit(1);
  }

  const evalsDir = resolve(values["evals-dir"] as string);
  const provider = values.provider as string;
  const threshold = Number(values.threshold);

  const critical = loadCriticalCases(evalsDir);
  const samples = loadRunSamples(evalsDir, provider);

  const stats: CaseStats[] = [];
  if (critical.length > 0) {
    for (const c of critical) {
      const cs = samples.get(c.id);
      if (!cs || cs.length === 0) continue;
      stats.push(computePassAtK(cs, threshold));
    }
  } else {
    // 没有 critical-cases.yaml 时，对所有 samples ≥ 2 次的 case 做计算
    for (const [, cs] of samples) {
      if (cs.length < 2) continue;
      stats.push(computePassAtK(cs, threshold));
    }
  }

  const md = renderReport(provider, stats, threshold);
  console.log(md);

  const outPath =
    typeof values.output === "string"
      ? resolve(values.output)
      : join(evalsDir, "_reports", `pass-at-k-${provider}.md`);
  if (!existsSync(join(evalsDir, "_reports"))) {
    // _reports 目录通常已存在，否则跳过写入
    console.warn("\n[pass-at-k] _reports 目录不存在，跳过文件写入");
  } else {
    writeFileSync(outPath, md, "utf-8");
    console.log(`\n[pass-at-k] 写入 ${outPath}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { computePassAtK, renderReport, type CaseStats };
