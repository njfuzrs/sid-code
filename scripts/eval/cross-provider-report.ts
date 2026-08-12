/**
 * Multi-provider 横评数据独立化（T-22 §6.5）
 *
 * 设计依据：docs/eval/investigations/eval-rubric-industry-survey.md §6.5 T-22
 * 业界对齐：Artificial Analysis Coding Agent Index 的"correctness 与 cost / time / token 独立报告"
 *
 * 用途：
 *   - "sid-code vs claude-code vs codex" 横评数据从 baseline_scores 拆出来
 *   - 独立成 evals/cross-provider/{date}.jsonl
 *   - 4 组独立指标：correctness / cost / time / pass-rate
 *   - 不混入 case yaml 的 baseline_scores（避免"模型成本差异"混入"agent 能力差异"）
 *
 * 用法：
 *   bun run scripts/eval/cross-provider-report.ts --providers sid-code-deepseek,claude-code --since 2026-05-01
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

interface RunRecord {
  case_id: string;
  provider: string;
  score: number | null;
  named_scores?: Record<string, number | null>;
  latency_ms?: number;
  meta?: {
    total_tokens?: number;
    token_breakdown?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_creation?: number;
    };
  };
  is_median?: boolean;
  tested_at: string;
  run_status?: string;
}

interface ProviderStats {
  provider: string;
  totalCases: number;
  passCount: number; // score >= 2.5
  passRate: number;
  avgScore: number | null; // correctness：归一化到 5 分制
  avgLatencyMs: number | null;
  avgTokensPerCase: number | null;
  avgCostUsd: number | null; // 按 token 估算（待精算时填进价表）
  errorCount: number; // null score 数量
}

const TOKEN_PRICING_USD: Record<
  string,
  { input: number; output: number; cache_read: number; cache_creation: number }
> = {
  // 单位：USD per 1M token
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  "claude-opus-4-7": { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  "deepseek-v4-pro": { input: 0.28, output: 1.1, cache_read: 0.028, cache_creation: 0.28 },
  default: { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25 },
};

function pricingFor(provider: string): (typeof TOKEN_PRICING_USD)["default"] {
  // sid-code-deepseek-v4-pro / claude-code-claude-opus-4-7 等 → 取关键字段
  for (const key of Object.keys(TOKEN_PRICING_USD)) {
    if (provider.includes(key)) return TOKEN_PRICING_USD[key];
  }
  return TOKEN_PRICING_USD.default;
}

function loadRunHistory(evalsDir: string, provider: string, since?: string): RunRecord[] {
  const path = join(evalsDir, "_runs", `${provider}.jsonl`);
  if (!existsSync(path)) return [];
  const out: RunRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (r.is_median === false) continue; // 仅取中位数
      if (since && r.tested_at < since) continue;
      out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

function computeStats(provider: string, records: RunRecord[]): ProviderStats {
  const totalCases = new Set(records.map((r) => r.case_id)).size;
  const validScores = records.map((r) => r.score).filter((s): s is number => typeof s === "number");
  const passCount = validScores.filter((s) => s >= 2.5).length;
  const errorCount = records.filter((r) => r.score === null).length;
  const avgScore =
    validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : null;
  const latencies = records
    .map((r) => r.latency_ms)
    .filter((x): x is number => typeof x === "number");
  const avgLatencyMs =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const tokens = records
    .map((r) => r.meta?.total_tokens)
    .filter((x): x is number => typeof x === "number");
  const avgTokensPerCase =
    tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null;

  // Cost 估算
  const pricing = pricingFor(provider);
  const costs: number[] = [];
  for (const r of records) {
    const tb = r.meta?.token_breakdown;
    if (!tb) continue;
    const cost =
      ((tb.input || 0) * pricing.input +
        (tb.output || 0) * pricing.output +
        (tb.cache_read || 0) * pricing.cache_read +
        (tb.cache_creation || 0) * pricing.cache_creation) /
      1_000_000;
    costs.push(cost);
  }
  const avgCostUsd = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : null;

  return {
    provider,
    totalCases,
    passCount,
    passRate: validScores.length > 0 ? passCount / validScores.length : 0,
    avgScore: avgScore !== null ? Number(avgScore.toFixed(3)) : null,
    avgLatencyMs: avgLatencyMs !== null ? Math.round(avgLatencyMs) : null,
    avgTokensPerCase: avgTokensPerCase !== null ? Math.round(avgTokensPerCase) : null,
    avgCostUsd: avgCostUsd !== null ? Number(avgCostUsd.toFixed(4)) : null,
    errorCount,
  };
}

function renderReport(stats: ProviderStats[], since: string | undefined): string {
  const lines: string[] = [];
  lines.push("# Multi-provider 横评报告（独立指标，不混 baseline_scores）");
  lines.push("");
  lines.push(`> 生成时间: ${new Date().toISOString()}`);
  lines.push(`> 数据范围: ${since ? `since ${since}` : "全部历史"}`);
  lines.push(
    `> 业界对齐: Artificial Analysis Coding Agent Index — correctness / cost / time / token 独立报告`,
  );
  lines.push("");
  lines.push("## 1. Correctness（衡量能力，主指标）");
  lines.push("");
  lines.push("| provider | cases | pass | pass_rate | avg_score (5 分制) | error |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of stats) {
    lines.push(
      `| ${s.provider} | ${s.totalCases} | ${s.passCount} | ${(s.passRate * 100).toFixed(1)}% | ${s.avgScore?.toFixed(2) ?? "–"} | ${s.errorCount} |`,
    );
  }
  lines.push("");
  lines.push("## 2. Cost（独立指标，不进 correctness 总分）");
  lines.push("");
  lines.push("| provider | avg_cost_usd | avg_tokens_per_case | cost_per_pass |");
  lines.push("|---|---|---|---|");
  for (const s of stats) {
    const costPerPass =
      s.avgCostUsd && s.passRate > 0 ? `$${(s.avgCostUsd / s.passRate).toFixed(4)}` : "–";
    lines.push(
      `| ${s.provider} | ${s.avgCostUsd ? `$${s.avgCostUsd}` : "–"} | ${s.avgTokensPerCase ?? "–"} | ${costPerPass} |`,
    );
  }
  lines.push("");
  lines.push("## 3. Time（独立指标）");
  lines.push("");
  lines.push("| provider | avg_latency (ms) | avg_latency (s) |");
  lines.push("|---|---|---|");
  for (const s of stats) {
    lines.push(
      `| ${s.provider} | ${s.avgLatencyMs ?? "–"} | ${s.avgLatencyMs ? (s.avgLatencyMs / 1000).toFixed(1) : "–"} |`,
    );
  }
  lines.push("");
  lines.push("## 4. 设计原则");
  lines.push("");
  lines.push("- **correctness 与 cost / time 严格独立**：不并入加权总分（业界共识 C4）");
  lines.push(
    "- **不写 case yaml 的 baseline_scores**：横评数据生命周期短（每周 / 每月一次），不污染 case 永久 baseline",
  );
  lines.push(
    "- **token pricing 表见 `scripts/eval/cross-provider-report.ts`**：仅供横评，不进 grader",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      providers: { type: "string", default: "" },
      since: { type: "string", default: "" },
      "evals-dir": { type: "string", default: "evals" },
      output: { type: "string" },
    },
  });

  const evalsDir = resolve(values["evals-dir"] as string);
  const providers = String(values.providers ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const since = values.since ? String(values.since) : undefined;

  if (providers.length === 0) {
    console.error("用法: bun run scripts/eval/cross-provider-report.ts --providers <p1,p2,...>");
    process.exit(1);
  }

  const stats: ProviderStats[] = [];
  for (const p of providers) {
    const records = loadRunHistory(evalsDir, p, since);
    if (records.length === 0) {
      console.warn(`[cross-provider] ${p} 无运行记录，跳过`);
      continue;
    }
    stats.push(computeStats(p, records));
  }

  const md = renderReport(stats, since);
  console.log(md);

  const outDir = join(evalsDir, "cross-provider");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 10);
  const outPath =
    typeof values.output === "string" ? resolve(values.output) : join(outDir, `${ts}.md`);
  writeFileSync(outPath, md, "utf-8");
  // 同时存 jsonl 供后续工具消费
  writeFileSync(
    join(outDir, `${ts}.jsonl`),
    stats.map((s) => JSON.stringify(s)).join("\n"),
    "utf-8",
  );
  console.log(`\n[cross-provider] 写入 ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { computeStats, renderReport, type ProviderStats };
