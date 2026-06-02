/**
 * eval:context-capability — 跑 Context 子系统 capability eval（S0-T04）
 *
 * 用法：
 *   bun run scripts/eval/run-context-capability.ts                  # 跑全部 + 跳过 LLM Judge
 *   bun run scripts/eval/run-context-capability.ts --case case_ctx_001
 *   bun run scripts/eval/run-context-capability.ts --execute        # 真调 LLM Judge
 *   bun run scripts/eval/run-context-capability.ts --sync           # 回写 baseline_scores
 *
 * 必须依赖 sid-code-live adapter（ADR-016）。
 * 输出：
 *   evals/raw-outputs/capability-context-<ts>.jsonl
 *   evals/_reports/capability-context-<ts>.json
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
} from "eval-framework/core/baseline-sync.ts";
import {
  loadCapabilityCases,
  runSharedCheck,
  aggregateCapabilityScore,
  classifyRunStatus,
  medianSuccessScore,
  pickRunStatus,
  type SharedGraderInput,
  type CheckResult,
  type GraderRule,
} from "../../evals/bench-runner/capability-shared.ts";

const ROOT = process.cwd();
const CAPABILITY_DIR = join(ROOT, "evals/capability/context");
const RAW_DIR = join(ROOT, "evals/raw-outputs");
const REPORT_DIR = join(ROOT, "evals/_reports");

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    execute: { type: "boolean", default: false },
    timeout: { type: "string", default: "240000" },
    model: { type: "string" },
    sync: { type: "boolean", default: false },
    samples: { type: "string", default: "1" },
  },
  allowPositionals: true,
});

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

// ============================================================
// context case 类型 + 专属 check
// ============================================================

interface ContextCaseExpected {
  execution_must_call_tools_any_of?: string[];
  execution_must_not_call_tools?: string[];
  final_response_must_include_any_of?: string[];
  final_response_must_not_include?: string[];
  final_response_max_length?: number;
  final_response_min_length?: number;
  exit_status_must_be?: string[];
  max_steps?: number;
  execution_must_not_call_tools_overuse_grep_3plus?: boolean;
}

interface ContextGraderInput {
  expected: ContextCaseExpected;
  toolsCalled: string[];
  steps: number;
  finalResponse: string;
  exitStatus: string;
}

/** context 子系统专属 check 处理 */
function runContextCheck(rule: GraderRule, input: ContextGraderInput): CheckResult {
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
    case "final_response_min_length_ok": {
      const min = expected.final_response_min_length ?? 0;
      const len = input.finalResponse.length;
      const ok = len >= min;
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: `length=${len} ${ok ? "≥" : "<"} ${min}`,
      };
    }
    case "final_response_max_length_ok": {
      const max = expected.final_response_max_length ?? Infinity;
      const len = input.finalResponse.length;
      const ok = len <= max;
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: `length=${len} ${ok ? "≤" : ">"} ${max}`,
      };
    }
    case "tool_call_count_le_5": {
      const count = input.toolsCalled.length;
      const ok = count <= 5;
      return { check, passed: ok, weight: rule.weight, reason: `tool_calls=${count} ${ok ? "≤" : ">"} 5` };
    }
    case "execution_must_not_call_tools_overuse_grep_3plus_hit": {
      // 反向: grep 不应被调用 3 次以上
      const grepCount = input.toolsCalled.filter((t) => t.toLowerCase() === "grep").length;
      const ok = grepCount < 3;
      return {
        check,
        passed: ok,
        weight: rule.weight,
        reason: `grep 调用 ${grepCount} 次 ${ok ? "<" : "≥"} 3`,
      };
    }
    default:
      return { check, passed: false, weight: rule.weight, reason: `未知 check: ${check}` };
  }
}

// ============================================================
// 主流程
// ============================================================

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

const cases = loadCapabilityCases<ContextCaseExpected>(CAPABILITY_DIR, "case_ctx_", values.case);
if (cases.length === 0) {
  console.error(`✗ 未找到 context capability case${values.case ? ` (filter=${values.case})` : ""}`);
  process.exit(1);
}

console.log(`Mode      : ${values.execute ? "execute (真调 LLM Judge)" : "skip-llm-judge (省钱模式)"}`);
console.log(`Adapter   : sid-code-live`);
console.log(`Model     : ${liveConfig.model}`);
console.log(`Timeout   : ${liveConfig.timeoutMs}ms`);
console.log(`Cases     : ${cases.length} 条 (${cases.map((c) => c.id).join(", ")})`);
console.log("");

const ts = Date.now();
const rawOutputPath = join(RAW_DIR, `capability-context-${ts}.jsonl`);
const reportOutputPath = join(REPORT_DIR, `capability-context-${ts}.json`);

interface SampleSnapshot {
  finalScore: number;
  assertScore: number;
  llmScore: number | null;
  runStatus: string;
  exitStatus: string;
  timedOut: boolean;
  elapsedSec: number;
  toolsCalled: string[];
  steps: number;
}

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
  samples: SampleSnapshot[];
  aggregatedRunStatus: string;
}

const samplesN = Math.max(1, parseInt(values.samples || "1", 10));
const results: CaseResult[] = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  console.log(
    `[${i + 1}/${cases.length}] ${c.id} (${c.dimension}) — 启动 sid-code-live ...${samplesN > 1 ? ` (samples=${samplesN})` : ""}`,
  );

  const sampleSnapshots: SampleSnapshot[] = [];
  let lastLive: SidCodeLiveResult | null = null;
  let lastDetails: Record<string, string | number | boolean> = {};
  let lastCheckSummary = "";

  for (let s = 0; s < samplesN; s++) {
    const startedAt = Date.now();
    let live: SidCodeLiveResult;
    try {
      live = await runSidCodeLive(c.input.user_query.trim(), liveConfig);
    } catch (err) {
      console.log(`    [sample ${s + 1}/${samplesN}] ✗ adapter error: ${String(err).slice(0, 200)}`);
      sampleSnapshots.push({
        finalScore: 0,
        assertScore: 0,
        llmScore: null,
        runStatus: "error",
        exitStatus: "adapter_error",
        timedOut: false,
        elapsedSec: (Date.now() - startedAt) / 1000,
        toolsCalled: [],
        steps: 0,
      });
      continue;
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;
    lastLive = live;

    const graderInput: ContextGraderInput = {
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
      assertResults.push(shared ?? runContextCheck(rule, graderInput));
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
    const sampleStatus = classifyRunStatus({
      exitStatus: live.output.exit_status,
      timedOut: live.timedOut,
    });

    sampleSnapshots.push({
      finalScore: agg.score,
      assertScore: agg.assertScore,
      llmScore: agg.llmScore,
      runStatus: sampleStatus,
      exitStatus: live.output.exit_status,
      timedOut: live.timedOut,
      elapsedSec,
      toolsCalled: live.output.tools_called,
      steps: live.output.steps,
    });
    lastDetails = agg.details;
    lastCheckSummary = assertResults.map((r) => `${r.check}=${r.passed ? "✓" : "✗"}`).join(" / ");

    if (samplesN > 1) {
      console.log(
        `    [sample ${s + 1}/${samplesN}] score=${agg.score}/5 (assert=${agg.assertScore}${llmScore != null ? `, judge=${llmScore}` : ""}) | ${elapsedSec.toFixed(1)}s | ${live.output.exit_status}${live.timedOut ? " ⚠️ timeout" : ""}`,
      );
    }
  }

  const aggregatedRunStatus = pickRunStatus(sampleSnapshots);
  const medianFinal =
    aggregatedRunStatus === "success"
      ? (medianSuccessScore(
          sampleSnapshots.map((sn) => ({ score: sn.finalScore, runStatus: sn.runStatus })),
        ) ?? 0)
      : 0;
  const medianAssert =
    aggregatedRunStatus === "success"
      ? (medianSuccessScore(
          sampleSnapshots.map((sn) => ({ score: sn.assertScore, runStatus: sn.runStatus })),
        ) ?? 0)
      : 0;
  const llmScores = sampleSnapshots
    .filter((sn) => sn.runStatus === "success" && sn.llmScore != null)
    .map((sn) => ({ score: sn.llmScore as number, runStatus: "success" }));
  const medianLlm = llmScores.length > 0 ? medianSuccessScore(llmScores) : null;

  const showLive = lastLive;
  const result: CaseResult = {
    id: c.id,
    dimension: c.dimension,
    priority: c.priority,
    finalScore: medianFinal,
    assertScore: medianAssert,
    llmScore: medianLlm,
    details: lastDetails,
    agentSnapshot: {
      tools_called: showLive?.output.tools_called ?? [],
      steps: showLive?.output.steps ?? 0,
      exit_status: showLive?.output.exit_status ?? "no_sample",
      timed_out: showLive?.timedOut ?? false,
      session_dir: showLive?.sessionDir ?? null,
    },
    reasoning:
      samplesN > 1
        ? `samples=${samplesN}, median=${medianFinal}/5 (assert=${medianAssert}), status=${aggregatedRunStatus}`
        : `${(sampleSnapshots[0]?.elapsedSec ?? 0).toFixed(1)}s, ${lastCheckSummary}`,
    samples: samplesN > 1 ? sampleSnapshots : [],
    aggregatedRunStatus,
  };
  if (showLive) {
    (result as unknown as { _stdout: string })._stdout = showLive.stdout.slice(-1500);
    (result as unknown as { _stderr: string })._stderr = showLive.stderr.slice(-1500);
  }
  results.push(result);

  if (samplesN > 1) {
    console.log(
      `    → median=${medianFinal}/5 (assert=${medianAssert}) | run_status=${aggregatedRunStatus}`,
    );
  } else {
    console.log(
      `    → score=${result.finalScore}/5 (assert=${result.assertScore}${result.llmScore != null ? `, judge=${result.llmScore}` : ""}) | ${(sampleSnapshots[0]?.elapsedSec ?? 0).toFixed(1)}s | ${result.agentSnapshot.exit_status}`,
    );
    if (showLive?.timedOut) {
      console.log(`    ⚠️  timeout`);
    }
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
  avgScore:
    results.length > 0
      ? Math.round((results.reduce((s, r) => s + r.finalScore, 0) / results.length) * 100) / 100
      : 0,
  passRate:
    results.length > 0
      ? Math.round((results.filter((r) => r.finalScore >= 4.0).length / results.length) * 100) / 100
      : 0,
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
console.log(`Context capability eval done`);
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
    const samples =
      r.samples.length > 0
        ? r.samples.map((sn) => ({
            score: sn.runStatus === "success" ? sn.finalScore : null,
            runStatus: sn.runStatus,
            testedAt: new Date(ts).toISOString(),
            dimensions: {
              assert: sn.runStatus === "success" ? sn.assertScore : null,
              llm_judge: sn.runStatus === "success" ? sn.llmScore : null,
            },
          }))
        : undefined;
    return {
      caseId: r.id,
      provider: providerKey,
      score: r.finalScore,
      runStatus: r.aggregatedRunStatus,
      testedAt: new Date(ts).toISOString(),
      dimensions: {
        assert: r.assertScore,
        llm_judge: r.llmScore,
      },
      mandatoryPass: r.aggregatedRunStatus === "success",
      graderType: "capability-context-v1",
      formulaVersion: { grader: "capability-context-v1" },
      samples,
    };
  });

  syncBaselineScores(baselineResults, {
    yamlDir: CAPABILITY_DIR,
    testerLabel: "eval:context-capability",
  });
}
