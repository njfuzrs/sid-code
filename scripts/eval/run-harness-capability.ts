/**
 * eval:harness-capability — 跑 Harness 子系统 capability eval（S0-T06）
 *
 * 用法：
 *   bun run scripts/eval/run-harness-capability.ts                  # 跑全部 + 跳过 LLM Judge
 *   bun run scripts/eval/run-harness-capability.ts --case case_hrn_001
 *   bun run scripts/eval/run-harness-capability.ts --execute        # 真调 LLM Judge
 *   bun run scripts/eval/run-harness-capability.ts --sync           # 回写 baseline_scores
 *
 * 注：完整的 harness_ablation / harness_overhead 维度需要 sid-code 支持
 *     --disable-loop-detection / --disable-auto-compact 等 flag,当前未实现。
 *     S2/S3 阶段补这些维度（M1 验收要求,见 04 §7.2.5）。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  runSidCodeLive,
  type SidCodeLiveConfig,
  type SidCodeLiveResult,
} from "../../evals/bench-runner/adapters/sid-code-live.ts";
import { gradeProcess, type JudgeConfig } from "../../evals/bench-runner/process-grader.ts";
import {
  syncBaselineScores,
  type BaselineResult,
} from "../../evals/baseline-sync.ts";
import {
  loadCapabilityCases,
  runSharedCheck,
  aggregateCapabilityScore,
  classifyRunStatus,
  type SharedGraderInput,
  type CheckResult,
  type GraderRule,
} from "../../evals/bench-runner/capability-shared.ts";

const ROOT = process.cwd();
const CAPABILITY_DIR = join(ROOT, "evals/capability/harness");
const RAW_DIR = join(ROOT, "evals/raw-outputs");
const REPORT_DIR = join(ROOT, "evals/_reports");

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    execute: { type: "boolean", default: false },
    timeout: { type: "string", default: "240000" },
    model: { type: "string" },
    sync: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

interface HarnessCaseExpected {
  execution_must_call_tools_any_of?: string[];
  execution_must_not_call_tools?: string[];
  final_response_must_include_any_of?: string[];
  final_response_must_not_include?: string[];
  exit_status_must_be?: string[];
  max_steps?: number;
  read_call_count_le_5?: boolean;
  unique_tools_count_min_2?: boolean;
}

interface HarnessGraderInput {
  expected: HarnessCaseExpected;
  toolsCalled: string[];
  steps: number;
  finalResponse: string;
  exitStatus: string;
}

function runHarnessCheck(rule: GraderRule, input: HarnessGraderInput): CheckResult {
  const check = rule.check || "";
  const expected = input.expected;

  switch (check) {
    case "exit_status_must_be_any_of_hit": {
      const list = expected.exit_status_must_be || [];
      const ok = list.includes(input.exitStatus);
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: ok ? `exit=${input.exitStatus}` : `expected ${list.join("|")},实际 ${input.exitStatus}`,
      };
    }
    case "read_call_count_le_5_hit": {
      const readCount = input.toolsCalled.filter((t) => t.toLowerCase() === "read").length;
      const ok = readCount <= 5;
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: `read 调用 ${readCount} 次 ${ok ? "≤" : ">"} 5`,
      };
    }
    case "unique_tools_count_min_2_hit": {
      const uniq = new Set(input.toolsCalled.map((t) => t.toLowerCase()));
      const ok = uniq.size >= 2;
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: `唯一工具数 ${uniq.size} ${ok ? "≥" : "<"} 2 (tools=[${[...uniq].join(",")}])`,
      };
    }
    default:
      return { check, passed: false, weight: rule.weight, reason: `未知 check: ${check}` };
  }
}

const judgeConfig: JudgeConfig = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1",
  model: process.env.JUDGE_MODEL || "claude-sonnet-4-6",
  promptPath: join(ROOT, "evals/_judge/prompt-v2.md"),
};

const liveConfig: SidCodeLiveConfig = {
  cwd: ROOT,
  model: values.model || process.env.SID_CODE_MODEL || "deepseek-v4-pro",
  timeoutMs: parseInt(values.timeout || "240000", 10),
};

const cases = loadCapabilityCases<HarnessCaseExpected>(CAPABILITY_DIR, "case_hrn_", values.case);
if (cases.length === 0) {
  console.error(`✗ 未找到 harness capability case${values.case ? ` (filter=${values.case})` : ""}`);
  process.exit(1);
}

console.log(`Mode      : ${values.execute ? "execute (真调 LLM Judge)" : "skip-llm-judge (省钱模式)"}`);
console.log(`Adapter   : sid-code-live`);
console.log(`Model     : ${liveConfig.model}`);
console.log(`Timeout   : ${liveConfig.timeoutMs}ms`);
console.log(`Cases     : ${cases.length} 条 (${cases.map((c) => c.id).join(", ")})`);
console.log("");

const ts = Date.now();
const rawOutputPath = join(RAW_DIR, `capability-harness-${ts}.jsonl`);
const reportOutputPath = join(REPORT_DIR, `capability-harness-${ts}.json`);

interface CaseResult {
  id: string;
  dimension: string;
  priority: string;
  finalScore: number;
  assertScore: number;
  llmScore: number | null;
  details: Record<string, string | number | boolean>;
  agentSnapshot: {
    tools_called: string[];
    steps: number;
    exit_status: string;
    timed_out: boolean;
    session_dir: string | null;
  };
  reasoning: string;
}

const results: CaseResult[] = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  console.log(`[${i + 1}/${cases.length}] ${c.id} (${c.dimension}) — 启动 sid-code-live ...`);

  const startedAt = Date.now();
  let live: SidCodeLiveResult;
  try {
    live = await runSidCodeLive(c.input.user_query.trim(), liveConfig);
  } catch (err) {
    console.log(`    ✗ adapter error: ${String(err).slice(0, 200)}`);
    continue;
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const graderInput: HarnessGraderInput = {
    expected: c.expected,
    toolsCalled: live.output.tools_called,
    steps: live.output.steps,
    finalResponse: live.output.final_response,
    exitStatus: live.output.exit_status,
  };
  const sharedInput: SharedGraderInput = {
    expected: c.expected as Record<string, unknown>,
    toolsCalled: graderInput.toolsCalled,
    steps: graderInput.steps,
    finalResponse: graderInput.finalResponse,
    userQuery: c.input.user_query,
  };

  const assertResults: CheckResult[] = [];
  let llmRule: GraderRule | null = null;
  for (const rule of c.grader) {
    if (rule.type === "llm_judge") {
      llmRule = rule;
      continue;
    }
    const shared = runSharedCheck(rule, sharedInput);
    assertResults.push(shared ?? runHarnessCheck(rule, graderInput));
  }

  let llmScore: number | undefined;
  if (values.execute && llmRule && judgeConfig.apiKey) {
    const judgeInput = {
      task: c.input.user_query.slice(0, 1500),
      expected: {
        must_include_keywords: c.expected.final_response_must_include_any_of,
        must_call_tools: c.expected.execution_must_call_tools_any_of,
        max_steps: c.expected.max_steps,
      },
      agentResponse: live.output.final_response,
    };
    const judgeResult = await gradeProcess(judgeInput, judgeConfig);
    llmScore = judgeResult.score;
  }

  const agg = aggregateCapabilityScore({
    assertResults,
    llmJudgeScore: llmScore,
    llmJudgeWeight: llmRule?.weight,
  });

  const checkSummary = assertResults.map((r) => `${r.check}=${r.passed ? "✓" : "✗"}`).join(" / ");

  const result: CaseResult = {
    id: c.id,
    dimension: c.dimension,
    priority: c.priority,
    finalScore: agg.score,
    assertScore: agg.assertScore,
    llmScore: agg.llmScore,
    details: agg.details,
    agentSnapshot: {
      tools_called: live.output.tools_called,
      steps: live.output.steps,
      exit_status: live.output.exit_status,
      timed_out: live.timedOut,
      session_dir: live.sessionDir,
    },
    reasoning: `${elapsed}s, ${checkSummary}${llmScore != null ? `, judge=${llmScore}` : ""}`,
  };
  (result as unknown as { _stdout: string })._stdout = live.stdout.slice(-1500);
  (result as unknown as { _stderr: string })._stderr = live.stderr.slice(-1500);
  results.push(result);

  console.log(
    `    → score=${result.finalScore}/5 (assert=${result.assertScore}${llmScore != null ? `, judge=${llmScore}` : ""}) | ${elapsed}s | ${result.agentSnapshot.exit_status}`,
  );
  if (live.timedOut) {
    console.log(`    ⚠️  timeout`);
  }
}

const rawContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
await Bun.write(rawOutputPath, rawContent);

const byDimension: Record<string, CaseResult[]> = {};
for (const r of results) {
  if (!byDimension[r.dimension]) byDimension[r.dimension] = [];
  byDimension[r.dimension].push(r);
}

const dimensionSummary: Record<string, { avgScore: number; count: number; passRate: number }> = {};
for (const [dim, list] of Object.entries(byDimension)) {
  const avg = list.reduce((s, r) => s + r.finalScore, 0) / list.length;
  const passed = list.filter((r) => r.finalScore >= 4.0).length;
  dimensionSummary[dim] = {
    avgScore: Math.round(avg * 100) / 100,
    count: list.length,
    passRate: Math.round((passed / list.length) * 100) / 100,
  };
}

const overall = {
  total: results.length,
  avgScore: results.length > 0 ? Math.round((results.reduce((s, r) => s + r.finalScore, 0) / results.length) * 100) / 100 : 0,
  passRate: results.length > 0 ? Math.round((results.filter((r) => r.finalScore >= 4.0).length / results.length) * 100) / 100 : 0,
};

await Bun.write(
  reportOutputPath,
  JSON.stringify(
    {
      timestamp: ts,
      mode: values.execute ? "execute" : "skip-llm-judge",
      model: liveConfig.model,
      overall,
      by_dimension: dimensionSummary,
      cases: results.map((r) => ({
        id: r.id,
        dimension: r.dimension,
        score: r.finalScore,
        assert: r.assertScore,
        judge: r.llmScore,
        timed_out: r.agentSnapshot.timed_out,
      })),
    },
    null,
    2,
  ),
);

console.log("\n" + "=".repeat(60));
console.log(`Harness capability eval done`);
console.log("=".repeat(60));
console.log(`  Total: ${overall.total} | avg=${overall.avgScore}/5 | pass=${(overall.passRate * 100).toFixed(0)}%`);
console.log(`  By dimension:`);
for (const [dim, s] of Object.entries(dimensionSummary)) {
  console.log(`    ${dim.padEnd(28)} avg=${s.avgScore} pass=${(s.passRate * 100).toFixed(0)}% (n=${s.count})`);
}
console.log(`\n  Raw  → ${rawOutputPath}`);
console.log(`  Report → ${reportOutputPath}`);

if (values.sync) {
  const modelSlug = (liveConfig.model || "default").replace(/[^a-zA-Z0-9]/g, "_");
  const providerKey = `sid_code_${modelSlug}`;

  const baselineResults: BaselineResult[] = results.map((r) => {
    const runStatus = classifyRunStatus({
      exitStatus: r.agentSnapshot.exit_status,
      timedOut: r.agentSnapshot.timed_out,
    });
    return {
      caseId: r.id,
      provider: providerKey,
      score: r.finalScore,
      runStatus,
      testedAt: new Date(ts).toISOString(),
      dimensions: {
        assert: r.assertScore,
        llm_judge: r.llmScore,
      },
      formulaVersion: { grader: "capability-harness-v1" },
    };
  });

  syncBaselineScores(baselineResults, {
    yamlDir: CAPABILITY_DIR,
    testerLabel: "eval:harness-capability",
  });
}
