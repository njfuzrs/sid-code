/**
 * 横向对比脚本：用 claude-code adapter 跑 smoke case，与 sid-code 离线 baseline 对比
 */

import { join } from "node:path";
import {
  runClaudeCode,
  type ClaudeCodeConfig,
} from "../../evals/bench-runner/adapters/claude-code.ts";
import {
  gradeProcess,
  type JudgeConfig,
  type JudgeInput,
} from "../../evals/bench-runner/process-grader.ts";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "../..");
const CASE_DIRS = [
  join(ROOT, "evals/general/p0-core"),
  join(ROOT, "evals/general/p1-common"),
  join(ROOT, "evals/general/p2-edge"),
];
const OUTPUT_DIR = join(ROOT, "evals/raw-outputs");

interface CaseYaml {
  id: string;
  category: string;
  priority: string;
  holdout?: boolean;
  input: { user_query: string };
  expected: {
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    max_steps?: number;
  };
  baseline_scores?: Record<string, { score: number | null }>;
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    case: { type: "string" },
    model: { type: "string", default: "claude-opus-4-7" },
    "max-turns": { type: "string", default: "30" },
    "timeout-ms": { type: "string", default: "300000" },
    "skip-holdout": { type: "boolean", default: true },
    "dry-run": { type: "boolean", default: false },
    "with-judge": { type: "boolean", default: false },
  },
  strict: false,
});

async function loadCases(): Promise<CaseYaml[]> {
  const { parse } = await import("yaml");
  const cases: CaseYaml[] = [];

  for (const dir of CASE_DIRS) {
    const files = await Array.fromAsync(new Bun.Glob("*.yaml").scan(dir));
    for (const f of files) {
      const content = await Bun.file(join(dir, f)).text();
      const c = parse(content) as CaseYaml;
      if (values["skip-holdout"] && c.holdout) continue;
      if (values.case && c.id !== values.case) continue;
      cases.push(c);
    }
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function checkKeywords(response: string, keywords: string[]): number {
  if (!keywords || keywords.length === 0) return 0;
  return keywords.filter((kw) => response.toLowerCase().includes(kw.toLowerCase())).length;
}

function scoreOutcome(response: string, expected: CaseYaml["expected"]): number {
  let score = 5.0;
  const mustInclude = expected.must_include_any_of || [];
  const mustNot = expected.must_not_include || [];

  if (mustInclude.length > 0) {
    const hits = checkKeywords(response, mustInclude);
    if (hits === 0) score -= 3.0;
    else if (hits < mustInclude.length / 2) score -= 1.0;
  }

  const notHits = checkKeywords(response, mustNot);
  if (notHits > 0) score -= 2.0 * notHits;

  return Math.max(0, Math.min(5, score));
}

async function main() {
  const cases = await loadCases();
  console.log(`横向对比 — claude-code adapter`);
  console.log(`  模型: ${values.model}`);
  console.log(`  Case 数: ${cases.length}`);
  console.log(`  Max turns: ${values["max-turns"]}`);
  console.log(`  Timeout: ${values["timeout-ms"]}ms`);
  console.log(`  Dry-run: ${values["dry-run"]}`);
  console.log(`  With Judge: ${values["with-judge"]}`);
  console.log("");

  if (cases.length === 0) {
    console.error("没有找到匹配的 case");
    process.exit(1);
  }

  const config: ClaudeCodeConfig = {
    cliPath: "claude",
    model: values.model!,
    timeoutMs: parseInt(values["timeout-ms"]!),
    skipPermissions: true,
    maxTurns: parseInt(values["max-turns"]!),
  };

  const judgeConfig: JudgeConfig | null = values["with-judge"]
    ? {
        apiKey: process.env.ANTHROPIC_AUTH_TOKEN || "",
        baseUrl: "http://127.0.0.1:4000/v1",
        model: "claude-opus-4-7",
        promptPath: join(ROOT, "evals/_judge/prompt-v3.md"),
      }
    : null;

  const results: Array<{
    caseId: string;
    category: string;
    priority: string;
    outcomeScore: number;
    judgeScore: number | null;
    finalScore: number;
    numTurns: number;
    costUsd: number;
    timedOut: boolean;
    keywordHits: number;
    keywordTotal: number;
  }> = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(`  [${i + 1}/${cases.length}] ${c.id} (${c.category}) ...`);

    if (values["dry-run"]) {
      console.log(`    → [dry-run] 跳过`);
      results.push({
        caseId: c.id,
        category: c.category,
        priority: c.priority,
        outcomeScore: 0,
        judgeScore: null,
        finalScore: 0,
        numTurns: 0,
        costUsd: 0,
        timedOut: false,
        keywordHits: 0,
        keywordTotal: (c.expected.must_include_any_of || []).length,
      });
      continue;
    }

    const result = await runClaudeCode(c.input.user_query, config);

    const outcomeScore = scoreOutcome(result.output.final_response, c.expected);
    const mustInclude = c.expected.must_include_any_of || [];
    const keywordHits = checkKeywords(result.output.final_response, mustInclude);

    let judgeScore: number | null = null;
    if (judgeConfig && result.output.final_response) {
      const judgeInput: JudgeInput = {
        task: c.input.user_query,
        expected: {
          must_include_keywords: mustInclude,
          must_call_tools: c.expected.must_call_tools || [],
          must_not_modify_files: [],
          max_steps: c.expected.max_steps || 30,
        },
        agentResponse: result.output.final_response.slice(0, 3000),
      };
      const judgeResult = await gradeProcess(judgeInput, judgeConfig);
      judgeScore = judgeResult.score;
      await new Promise((r) => setTimeout(r, 500));
    }

    const finalScore = judgeScore !== null ? outcomeScore * 0.6 + judgeScore * 0.4 : outcomeScore;

    results.push({
      caseId: c.id,
      category: c.category,
      priority: c.priority,
      outcomeScore,
      judgeScore,
      finalScore: Math.round(finalScore * 10) / 10,
      numTurns: result.output.steps,
      costUsd: result.costUsd,
      timedOut: result.timedOut,
      keywordHits,
      keywordTotal: mustInclude.length,
    });

    const marker = outcomeScore >= 4 ? "✓" : outcomeScore >= 3 ? "~" : "✗";
    console.log(
      `    → ${marker} outcome=${outcomeScore.toFixed(1)} judge=${judgeScore ?? "-"} turns=${result.output.steps} cost=$${result.costUsd.toFixed(3)} keywords=${keywordHits}/${mustInclude.length}`,
    );
  }

  // 落盘
  const ts = Date.now();
  const outputPath = join(OUTPUT_DIR, `cross-baseline-claude-code-${ts}.jsonl`);
  const outputContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await Bun.write(outputPath, outputContent);
  console.log(`\n  结果写入: ${outputPath}`);

  // 汇总
  const validResults = results.filter((r) => !values["dry-run"]);
  if (validResults.length > 0) {
    const avgOutcome = validResults.reduce((s, r) => s + r.outcomeScore, 0) / validResults.length;
    const avgFinal = validResults.reduce((s, r) => s + r.finalScore, 0) / validResults.length;
    const totalCost = validResults.reduce((s, r) => s + r.costUsd, 0);
    const timeouts = validResults.filter((r) => r.timedOut).length;

    console.log(`\n  ========== 汇总 ==========`);
    console.log(`  Case 数: ${validResults.length}`);
    console.log(`  Avg Outcome Score: ${avgOutcome.toFixed(2)}/5`);
    console.log(`  Avg Final Score: ${avgFinal.toFixed(2)}/5`);
    console.log(`  Total Cost: $${totalCost.toFixed(3)}`);
    console.log(`  Timeouts: ${timeouts}/${validResults.length}`);
    console.log(`  ============================`);
  }
}

main().catch(console.error);
