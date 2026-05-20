/**
 * Judge 校准脚本 v3
 * 用 15 条校准答案（好/中/差各 5 条）× 3 次运行 = 45 条数据点
 * 计算 Spearman ρ + mean_delta，判定 Judge 是否达标（ρ >= 0.6）
 */

import { join } from "node:path";
import { gradeProcess, type JudgeConfig, type JudgeInput } from "../../evals/bench-runner/process-grader.ts";

const EVALS_DIR = join(import.meta.dir, "../..");
const CALIBRATION_FILE = join(EVALS_DIR, "evals/_judge/calibration-v3/answers.jsonl");
const JUDGE_PROMPT = join(EVALS_DIR, "evals/_judge/prompt-v3.md");
const OUTPUT_FILE = join(EVALS_DIR, "evals/_judge/calibration-v3/results.jsonl");
const RUNS = 3;

interface CalibrationAnswer {
  case_id: string;
  answer_quality: "good" | "medium" | "bad";
  author_score: number;
  task_summary: string;
  expected_keywords: string[];
  agent_response: string;
}

function spearmanRho(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  function rank(arr: number[]): number[] {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n && sorted[j].v === sorted[i].v) j++;
      const avgRank = (i + j + 1) / 2;
      for (let k = i; k < j; k++) ranks[sorted[k].i] = avgRank;
      i = j;
    }
    return ranks;
  }

  const rx = rank(x);
  const ry = rank(y);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

async function main() {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
  const baseUrl = process.env.JUDGE_BASE_URL || "http://127.0.0.1:4000/v1";
  const model = process.env.JUDGE_MODEL || "claude-opus-4-7";

  if (!apiKey) {
    console.error("错误：需要设置 ANTHROPIC_API_KEY 或 DASHSCOPE_API_KEY 环境变量");
    process.exit(1);
  }

  const judgeConfig: JudgeConfig = {
    apiKey,
    baseUrl,
    model,
    promptPath: JUDGE_PROMPT,
  };

  console.log(`Judge 校准 v3`);
  console.log(`  模型: ${model}`);
  console.log(`  Prompt: prompt-v2.md`);
  console.log(`  运行次数: ${RUNS}`);
  console.log(`  校准答案: ${CALIBRATION_FILE}`);
  console.log("");

  // 加载校准答案
  const rawLines = (await Bun.file(CALIBRATION_FILE).text()).trim().split("\n");
  const answers: CalibrationAnswer[] = rawLines.map((l) => JSON.parse(l));
  console.log(`  加载 ${answers.length} 条校准答案`);

  // 跑校准
  const results: Array<{
    case_id: string;
    run: number;
    answer_quality: string;
    author_score: number;
    judge_score: number;
  }> = [];

  for (let run = 0; run < RUNS; run++) {
    console.log(`\n  === Run ${run + 1}/${RUNS} ===`);
    for (const answer of answers) {
      const judgeInput: JudgeInput = {
        task: answer.task_summary,
        expected: {
          must_include_keywords: answer.expected_keywords,
          must_call_tools: [],
          must_not_modify_files: [],
          max_steps: 15,
        },
        agentResponse: answer.agent_response,
      };

      const result = await gradeProcess(judgeInput, judgeConfig);

      results.push({
        case_id: answer.case_id,
        run,
        answer_quality: answer.answer_quality,
        author_score: answer.author_score,
        judge_score: result.score,
      });

      const delta = Math.abs(result.score - answer.author_score);
      const marker = delta <= 1 ? "✓" : delta <= 2 ? "~" : "✗";
      console.log(
        `    ${answer.case_id} [${answer.answer_quality.padEnd(6)}] author=${answer.author_score} judge=${result.score} Δ=${delta} ${marker}`,
      );

      // 避免 rate limit
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 写结果
  const outputContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await Bun.write(OUTPUT_FILE, outputContent);
  console.log(`\n  结果写入: ${OUTPUT_FILE}`);

  // 计算指标
  const validResults = results.filter((r) => r.judge_score >= 0);
  const invalidCount = results.length - validResults.length;

  const authorScores = validResults.map((r) => r.author_score);
  const judgeScores = validResults.map((r) => r.judge_score);

  const rho = spearmanRho(authorScores, judgeScores);
  const deltas = validResults.map((r) => Math.abs(r.judge_score - r.author_score));
  const meanDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const maxDelta = Math.max(...deltas);

  console.log(`\n  ========== 校准结果 ==========`);
  console.log(`  有效判定: ${validResults.length}/${results.length}`);
  console.log(`  JSON 解析失败: ${invalidCount}/${results.length}`);
  console.log(`  Spearman ρ: ${rho.toFixed(3)}`);
  console.log(`  Mean |Δ|: ${meanDelta.toFixed(2)}`);
  console.log(`  Max |Δ|: ${maxDelta}`);
  console.log(`  ================================`);

  if (rho >= 0.6 && meanDelta <= 1.0) {
    console.log(`\n  ✅ 校准通过！ρ=${rho.toFixed(3)} >= 0.6, mean_delta=${meanDelta.toFixed(2)} <= 1.0`);
    console.log(`  → 锁定 prompt-v2，更新 kappa-history.md`);
  } else if (rho >= 0.5) {
    console.log(`\n  🟡 接近达标。ρ=${rho.toFixed(3)}，考虑微调 prompt 或增加 few-shot 示例`);
  } else {
    console.log(`\n  ❌ 未达标。ρ=${rho.toFixed(3)} < 0.6，需要写 prompt-v3`);
    console.log(`  建议：加 2 个 few-shot 示例（1 个 5 分 + 1 个 1 分）`);
  }

  // 按 answer_quality 分组统计
  console.log(`\n  按答案质量分组：`);
  for (const quality of ["good", "medium", "bad"] as const) {
    const group = validResults.filter((r) => r.answer_quality === quality);
    if (group.length === 0) continue;
    const avgJudge = group.reduce((s, r) => s + r.judge_score, 0) / group.length;
    const avgAuthor = group.reduce((s, r) => s + r.author_score, 0) / group.length;
    const groupDelta = group.reduce((s, r) => s + Math.abs(r.judge_score - r.author_score), 0) / group.length;
    console.log(`    ${quality.padEnd(6)}: avg_author=${avgAuthor.toFixed(1)} avg_judge=${avgJudge.toFixed(1)} mean_Δ=${groupDelta.toFixed(2)}`);
  }
}

main().catch(console.error);
