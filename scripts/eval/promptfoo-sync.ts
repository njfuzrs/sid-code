/**
 * promptfoo-sync — 把 promptfoo 跑分结果同步到 case yaml 的 baseline_scores
 *
 * 用法:
 *   bun run eval:horizontal-sync
 *   bun run eval:horizontal-sync -- --input evals/_reports/promptfoo-latest.json
 *   bun run eval:horizontal-sync -- --dry-run
 *
 * 数据流:
 *   evals/_reports/promptfoo-latest.json → 解析每个 test 的 provider/score/status
 *   → 写入对应 case yaml 的 baseline_scores.{provider_label} 字段
 *   → dashboard.ts 下次运行时自动读取
 *
 * provider label 映射(自动: labelToKey 把非字母数字替换为 _):
 *   "sid-code-gpt54"    → baseline_scores.sid_code_gpt54
 *   "sid-code-opus47"   → baseline_scores.sid_code_opus47
 *   "claude-code-opus47"→ baseline_scores.claude_code_opus47
 *   (旧) "sid-code-live"→ baseline_scores.sid_code_live
 *   (旧) "claude-code"  → baseline_scores.claude_code
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import yaml from "yaml";

const ROOT = resolve(import.meta.dir, "../..");
const CASE_DIRS = [
  join(ROOT, "evals/p0-core"),
  join(ROOT, "evals/p1-common"),
  join(ROOT, "evals/p2-edge"),
  join(ROOT, "evals/holdout"),
];

interface PromptfooResult {
  evalId: string;
  results: {
    timestamp: string;
    results: PromptfooTestResult[];
  };
}

interface PromptfooTestResult {
  provider: { id: string; label?: string };
  vars: Record<string, unknown>;
  response?: { output: string };
  score?: number;
  namedScores?: Record<string, number>;
  success: boolean;
  error?: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

function labelToKey(label: string): string {
  return label.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function findCaseYaml(caseId: string): string | null {
  for (const dir of CASE_DIRS) {
    const p = join(dir, `${caseId}.yaml`);
    if (existsSync(p)) return p;
  }
  return null;
}

function scoreToFivePoint(promptfooScore: number): number {
  return Math.round(promptfooScore * 5 * 10) / 10;
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string", default: "evals/_reports/promptfoo-latest.json" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const inputPath = resolve(ROOT, values.input as string);
  if (!existsSync(inputPath)) {
    console.error(`[promptfoo-sync] 未找到输入文件: ${inputPath}`);
    console.error(`  先跑: bun run eval:horizontal-run`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(inputPath, "utf-8")) as PromptfooResult;
  const results = raw.results?.results;
  if (!results || results.length === 0) {
    console.error("[promptfoo-sync] 结果为空");
    process.exit(1);
  }

  const timestamp = raw.results.timestamp;
  const dryRun = values["dry-run"] as boolean;

  console.log(`[promptfoo-sync] 读取 ${inputPath}`);
  console.log(`  evalId: ${raw.evalId}`);
  console.log(`  timestamp: ${timestamp}`);
  console.log(`  results: ${results.length} 条`);
  if (dryRun) console.log("  (dry-run 模式，不写入文件)");
  console.log("");

  const updates: Array<{ caseId: string; provider: string; score: number | null; status: string; namedScores?: Record<string, number> }> = [];

  for (const r of results) {
    const caseId = r.vars?.case_id as string | undefined;
    if (!caseId) continue;

    const providerLabel = r.provider.label || r.provider.id;
    const providerKey = labelToKey(providerLabel);

    const isTimeout = r.response?.output?.includes("TIMEOUT") || false;
    const isError = r.response?.output?.includes("[ERROR]") || false;

    let score: number | null = null;
    let runStatus = "pending";

    if (isTimeout) {
      runStatus = "timeout";
      // 如果 promptfoo 在超时前已完成评判并给了分，保留该分数（partial credit）
      if (typeof r.score === "number" && r.score > 0) {
        score = scoreToFivePoint(r.score);
      }
    } else if (isError) {
      runStatus = "error";
      // 如果 error 但有 partial score（比如 anchor_hit pass 了），保留
      if (typeof r.score === "number" && r.score > 0) {
        score = scoreToFivePoint(r.score);
      }
    } else if (typeof r.score === "number") {
      score = scoreToFivePoint(r.score);
      runStatus = "success";
    }

    updates.push({ caseId, provider: providerKey, score, status: runStatus, namedScores: r.namedScores });
  }

  // 按 case 分组写入
  const byCaseId = new Map<string, typeof updates>();
  for (const u of updates) {
    if (!byCaseId.has(u.caseId)) byCaseId.set(u.caseId, []);
    byCaseId.get(u.caseId)!.push(u);
  }

  let updatedCount = 0;
  for (const [caseId, caseUpdates] of byCaseId) {
    const yamlPath = findCaseYaml(caseId);
    if (!yamlPath) {
      console.warn(`  ⚠️ ${caseId}: 未找到 case yaml`);
      continue;
    }

    const content = readFileSync(yamlPath, "utf-8");
    const doc = yaml.parseDocument(content);
    const root = doc.contents as yaml.YAMLMap;

    let baselineNode = root.get("baseline_scores") as yaml.YAMLMap | undefined;
    if (!baselineNode) {
      baselineNode = doc.createNode({}) as yaml.YAMLMap;
      root.set("baseline_scores", baselineNode);
    }

    for (const u of caseUpdates) {
      const entry: Record<string, unknown> = {
        score: u.score,
        run_status: u.status,
        tested_at: timestamp,
        tested_by: "promptfoo",
        transcript_path: null,
        notes: u.status === "timeout" ? "promptfoo exec provider 360s 超时" : "",
        dimensions: {
          anchor_hit: u.namedScores?.anchor_hit ?? null,
          rubric_score: u.namedScores?.rubric_score ?? null,
          tool_compliance: u.namedScores?.tool_compliance ?? null,
          efficiency: u.namedScores?.efficiency ?? null,
          cost: u.namedScores?.cost ?? null,
        },
      };

      baselineNode.set(u.provider, doc.createNode(entry));

      const emoji = u.score != null ? (u.score >= 4 ? "✅" : u.score >= 3 ? "🟡" : "🔴") : "⏱️";
      console.log(`  ${emoji} ${caseId}.${u.provider} = ${u.score ?? u.status}`);
    }

    if (!dryRun) {
      writeFileSync(yamlPath, doc.toString(), "utf-8");
      updatedCount++;
    }
  }

  console.log("");
  console.log(`[promptfoo-sync] ${dryRun ? "将" : "已"}更新 ${updatedCount} 个 case yaml`);
  if (!dryRun) {
    console.log("  下一步: bun run eval:dashboard  (刷新 DASHBOARD.md)");
  }
}

main();
