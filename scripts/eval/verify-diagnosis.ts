/**
 * eval:verify-diagnosis — 修复后验证诊断方向是否正确,误诊沉淀到 misdiagnosis-log.jsonl
 *
 * A5-3 / 评测系统报告 §诊断能力 Step 3-5 实现。
 *
 * 流程:
 *   1. 读 evals/_diagnoses/runs/<run-id>/output.json (eval:diagnose 的输出)
 *   2. 读 case yaml 当前 baseline_scores 拿 score_after
 *   3. 读 input.json (诊断时的 score_before,可选)
 *   4. 计算 score_diff = score_after - score_before
 *   5. 判定 verified:
 *      - score_diff >= 0.5  → verified=true (修复方向正确)
 *      - score_diff <  0.3  → verified=false (误诊或修无效)
 *      - 0.3 <= diff < 0.5  → 标 inconclusive (部分有效但未达预期)
 *   6. 误诊 (verified=false) 写入 evals/_diagnoses/misdiagnosis-log.jsonl
 *
 * 用法:
 *   bun run eval:verify-diagnosis --run-id self-test --score-before 1.5 --case case_022
 *   bun run eval:verify-diagnosis --output-file evals/_diagnoses/runs/manual/output.json --providers sid_code_deepseek_v4_pro
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAllCases } from "./lib/yaml-loader";

const REPO_ROOT = process.cwd();
const EVALS_DIR = join(REPO_ROOT, "evals");
const DIAGNOSES_DIR = join(EVALS_DIR, "_diagnoses");
const MISDIAGNOSIS_LOG = join(DIAGNOSES_DIR, "misdiagnosis-log.jsonl");

interface DiagnoseEntry {
  case_id: string;
  fix_type: string;
  confidence: number;
  matched_rule: string | null;
  root_cause: string;
  total_score: number | null;
  evidence: Array<{ field: string; value: unknown; rule: string }>;
}

interface VerifyResult {
  case_id: string;
  ts: string;
  ai_fix_type: string;
  ai_confidence: number;
  ai_root_cause: string;
  matched_rule: string | null;
  score_before: number | null;
  score_after: number | null;
  score_diff: number | null;
  verified: boolean | "inconclusive";
  notes: string;
}

function getCurrentScore(caseId: string, provider: string): number | null {
  const all = loadAllCases(EVALS_DIR);
  const c = all.find((c) => c.id === caseId);
  if (!c) return null;
  const baseline = ((c as unknown as Record<string, unknown>).baseline_scores as Record<string, { score?: number | null }> | undefined)?.[provider];
  return typeof baseline?.score === "number" ? baseline.score : null;
}

function verifyEntry(
  entry: DiagnoseEntry,
  scoreBefore: number | null,
  provider: string,
  ts: string,
): VerifyResult {
  const scoreAfter = getCurrentScore(entry.case_id, provider);
  let scoreDiff: number | null = null;
  if (typeof scoreBefore === "number" && typeof scoreAfter === "number") {
    scoreDiff = scoreAfter - scoreBefore;
  }

  // 不同 fix_type 的"修复成功"信号方向不同:
  //   - code_bug / system_prompt / infra_bug: 修对 → 分数 ↑(agent 真做对了)
  //   - case_design: 修对 → 分数往真信号回归(去掉假阳/假阴),方向不一定上;
  //     特别是去 echo bias / 加反例: 假阳被杀掉 = 分数 ↓ 但是修对了
  //   - model_limit: 不能修(标 known_limitation),分数应稳定不变
  // 这里只能用|Δ| 区分"有变化 = 信号真"vs"完全没变 = 修无效"。
  let verified: boolean | "inconclusive" = "inconclusive";
  let notes = "";
  const direction: "up" | "down" | "stable" =
    entry.fix_type === "model_limit"
      ? "stable"
      : entry.fix_type === "case_design"
      ? "down" // 大多数 case_design fix(去 echo / 加反例)信号回归 = 分数下降
      : "up"; // code_bug / system_prompt / infra_bug 修对应该升分

  if (scoreDiff === null) {
    verified = "inconclusive";
    notes = "score_before / score_after 缺失,无法判定";
  } else if (direction === "stable") {
    // model_limit: |Δ| ≤ 0.3 视为已知限制(预期不修),Δ 大说明诊断方向错
    if (Math.abs(scoreDiff) <= 0.3) {
      verified = true;
      notes = `model_limit 修复无变化符合预期 (|Δ${scoreDiff.toFixed(2)}| ≤ 0.3)`;
    } else {
      verified = false;
      notes = `model_limit 但分数大幅变动 (|Δ${scoreDiff.toFixed(2)}| > 0.3),诊断方向可疑`;
    }
  } else if (direction === "up") {
    if (scoreDiff >= 0.5) {
      verified = true;
      notes = `修复方向正确,分数上升 (Δ${scoreDiff.toFixed(2)} ≥ 0.5)`;
    } else if (scoreDiff >= 0.2) {
      verified = "inconclusive";
      notes = `部分有效 (0.2 ≤ Δ${scoreDiff.toFixed(2)} < 0.5)`;
    } else {
      verified = false;
      notes = `修复无效或误诊 (Δ${scoreDiff.toFixed(2)} < 0.2)`;
    }
  } else {
    // direction === "down": case_design 类
    if (scoreDiff <= -0.2) {
      verified = true;
      notes = `case_design 修复方向正确,假阳信号被杀 (Δ${scoreDiff.toFixed(2)})`;
    } else if (Math.abs(scoreDiff) <= 0.2) {
      verified = "inconclusive";
      notes = `case_design 但分数变化小 (|Δ${scoreDiff.toFixed(2)}| ≤ 0.2),需人审是否修到位`;
    } else {
      // scoreDiff > 0.2: case_design 反而升分? 异常
      verified = false;
      notes = `case_design 但分数反升 (Δ${scoreDiff.toFixed(2)}),诊断方向可疑`;
    }
  }

  return {
    case_id: entry.case_id,
    ts,
    ai_fix_type: entry.fix_type,
    ai_confidence: entry.confidence,
    ai_root_cause: entry.root_cause,
    matched_rule: entry.matched_rule,
    score_before: scoreBefore,
    score_after: scoreAfter,
    score_diff: scoreDiff,
    verified,
    notes,
  };
}

function logMisdiagnosis(verifyResult: VerifyResult, additionalContext: { actual_fix_type?: string; lesson?: string } = {}) {
  if (verifyResult.verified !== false) return;
  const entry = {
    ts: verifyResult.ts,
    case_id: verifyResult.case_id,
    diagnose_run_id: "manual", // §0 禁止 Date.now;手动 run-id
    ai_fix_type: verifyResult.ai_fix_type,
    ai_confidence: verifyResult.ai_confidence,
    ai_root_cause: verifyResult.ai_root_cause,
    matched_rule: verifyResult.matched_rule,
    score_before: verifyResult.score_before,
    score_after: verifyResult.score_after,
    score_diff: verifyResult.score_diff,
    regression_count: 0,
    verified: false,
    actual_fix_type: additionalContext.actual_fix_type ?? null,
    lesson: additionalContext.lesson ?? "(待人审补充)",
  };
  appendFileSync(MISDIAGNOSIS_LOG, JSON.stringify(entry) + "\n");
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "run-id": { type: "string" },
      "output-file": { type: "string" },
      "score-before": { type: "string" },
      "case": { type: "string" },
      provider: { type: "string", default: "sid_code_deepseek_v4_pro" },
      ts: { type: "string", default: "manual" },
    },
    allowPositionals: false,
  });

  const provider = values.provider as string;
  const ts = (values.ts as string) ?? "manual";
  let outputPath: string;
  if (values["output-file"]) {
    outputPath = resolve(REPO_ROOT, values["output-file"] as string);
  } else if (values["run-id"]) {
    outputPath = join(DIAGNOSES_DIR, "runs", values["run-id"] as string, "output.json");
  } else {
    console.error("[verify-diagnosis] 必须传 --run-id 或 --output-file");
    process.exit(2);
  }

  if (!existsSync(outputPath)) {
    console.error(`[verify-diagnosis] 诊断输出文件不存在: ${outputPath}`);
    process.exit(2);
  }

  const data = JSON.parse(readFileSync(outputPath, "utf-8")) as { results?: DiagnoseEntry[] };
  if (!data.results || !Array.isArray(data.results)) {
    console.error("[verify-diagnosis] 诊断输出文件格式错误,缺少 results 数组");
    process.exit(2);
  }

  const targetCase = values["case"] as string | undefined;
  const scoreBefore = values["score-before"] ? Number(values["score-before"]) : null;

  const verifyResults: VerifyResult[] = [];
  for (const entry of data.results) {
    if (targetCase && entry.case_id !== targetCase) continue;
    // score_before 优先来源: --score-before 命令行 > entry.total_score (诊断时记录)
    const sb = scoreBefore ?? entry.total_score ?? null;
    const r = verifyEntry(entry, sb, provider, ts);
    verifyResults.push(r);
    console.log(
      `\n[verify] ${r.case_id}  fix_type=${r.ai_fix_type}  ` +
        `before=${r.score_before ?? "?"}  after=${r.score_after ?? "?"}  ` +
        `Δ=${r.score_diff?.toFixed(2) ?? "?"}  verified=${r.verified}\n  ${r.notes}`,
    );
    if (r.verified === false) {
      logMisdiagnosis(r);
      console.log(`  → 写入 misdiagnosis-log.jsonl`);
    }
  }

  // 汇总
  const total = verifyResults.length;
  const verified = verifyResults.filter((r) => r.verified === true).length;
  const inconclusive = verifyResults.filter((r) => r.verified === "inconclusive").length;
  const misdiagnosed = verifyResults.filter((r) => r.verified === false).length;
  console.log(`\n[verify-diagnosis] 汇总: ${total} 条 | verified=${verified} / inconclusive=${inconclusive} / misdiagnosed=${misdiagnosed}`);

  // 落盘 verify.json (与 output.json 同目录)
  const verifyDir = outputPath.replace(/output\.json$/, "");
  if (verifyDir !== outputPath) {
    const verifyPath = join(verifyDir, "verify.json");
    writeFileSync(verifyPath, JSON.stringify({ provider, ts, total, verified, inconclusive, misdiagnosed, results: verifyResults }, null, 2));
    console.log(`[verify-diagnosis] 输出: ${verifyPath}`);
  }
}

main();
