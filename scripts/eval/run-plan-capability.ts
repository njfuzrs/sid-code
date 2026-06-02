/**
 * eval:plan-capability — 跑 Plan 子系统 capability eval（W11 入口）
 *
 * 用法：
 *   bun run eval:plan-capability -- --case plan_009       # 跑单条
 *   bun run eval:plan-capability -- --execute             # 跑全部 + 真调 LLM Judge
 *   bun run eval:plan-capability                          # 跑全部 + 跳过 LLM Judge (省钱模式)
 *   bun run eval:plan-capability -- --samples 3 --sync    # N=3 中位数 + 回写 baseline
 *
 * 必须依赖 sid-code-live adapter（ADR-016）。
 * 输出：
 *   evals/raw-outputs/capability-plan-<ts>.jsonl       — 每条 case 的详细评分
 *   evals/_reports/capability-plan-<ts>.json          — 4 维度汇总（供后续 capability-plan-w11.md 用）
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  runSidCodeLive,
  type SidCodeLiveConfig,
  type SidCodeLiveResult,
} from "../../evals/bench-runner/adapters/sid-code-live.ts";
import {
  runAllChecks,
  aggregateCapabilityScore,
  type CapabilityCaseExpected,
  type GraderRule,
  type CapabilityGraderInput,
} from "../../evals/bench-runner/capability-grader.ts";
import { gradeProcess, type JudgeConfig } from "../../evals/bench-runner/process-grader.ts";
import {
  syncBaselineScores,
  type BaselineResult,
} from "eval-framework/core/baseline-sync.ts";
import {
  classifyRunStatus,
  medianSuccessScore,
  pickRunStatus,
} from "../../evals/bench-runner/capability-shared.ts";

const ROOT = process.cwd();
const CAPABILITY_DIR = join(ROOT, "evals/capability/plan");
const RAW_DIR = join(ROOT, "evals/raw-outputs");
const REPORT_DIR = join(ROOT, "evals/_reports");

const { values } = parseArgs({
  options: {
    case: { type: "string" }, // 只跑指定 case（e.g. plan_009）
    execute: { type: "boolean", default: false }, // 真调 LLM Judge
    timeout: { type: "string", default: "480000" }, // 单 task 超时（对齐 general runner 的 480s；plan 类 case 跨文件改造，原 360s 偏紧）
    model: { type: "string" }, // 覆盖默认模型
    // sync 默认 off：与 eval-runner 对齐，避免调试单 case 时污染 case yaml 的 baseline_scores。
    // 跑正式 baseline / 对比历史时显式加 --sync 才回写。
    sync: { type: "boolean", default: false },
    // multi-sample：N=3 中位数收敛 LLM 方差与偶发 timeout（对齐 memory/context/router/harness）
    samples: { type: "string", default: "1" },
  },
  allowPositionals: true,
});

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

interface CapabilityCase {
  id: string;
  subsystem: string;
  dimension: string;
  priority: string;
  input: {
    user_query: string;
    trigger_plan_mode?: boolean;
    mock_environment?: Record<string, unknown>;
  };
  expected: CapabilityCaseExpected;
  rubric?: Record<string, string>;
  grader: GraderRule[];
  related_adr?: string[];
}

/** 加载所有 plan_NNN_*.yaml */
function loadCases(caseFilter?: string): CapabilityCase[] {
  const files = readdirSync(CAPABILITY_DIR)
    .filter((f) => f.startsWith("plan_") && f.endsWith(".yaml"))
    .sort();
  const cases: CapabilityCase[] = [];
  for (const f of files) {
    const raw = readFileSync(join(CAPABILITY_DIR, f), "utf-8");
    const parsed = parseYaml(raw) as CapabilityCase;
    if (caseFilter && parsed.id !== caseFilter) continue;
    cases.push(parsed);
  }
  return cases;
}

/**
 * 构造给 sid-code 的 instruction
 * 把 trigger_plan_mode 和 mock_environment 拼到指令里
 */
function buildInstruction(c: CapabilityCase): { instruction: string; appendSystemPrompt: string } {
  let instruction = c.input.user_query.trim();

  if (c.input.trigger_plan_mode) {
    instruction = `[请进入 Plan Mode，先写计划再执行]\n\n${instruction}`;
  }

  // mock_environment → 注入到 system prompt
  let appendSystemPrompt = "";
  const mock = c.input.mock_environment as
    | {
        permission_denials?: Array<{ tool: string; file_pattern: string; reason: string }>;
        file_not_found?: string[];
      }
    | undefined;
  if (mock) {
    const lines: string[] = ["[评测注入]：本次会话中以下条件被模拟为失败，请按指令处理失败"];
    if (mock.permission_denials) {
      for (const p of mock.permission_denials) {
        lines.push(`- 使用 ${p.tool} 工具写入 ${p.file_pattern} 时，会返回错误："${p.reason}"`);
      }
    }
    if (mock.file_not_found) {
      for (const f of mock.file_not_found) {
        lines.push(`- 读取 ${f} 会返回 "file not found"`);
      }
    }
    appendSystemPrompt = lines.join("\n");
  }

  return { instruction, appendSystemPrompt };
}

/**
 * 推算 plan 文件 update 次数（recovery 维度专属）
 *
 * W12.D3 改动：从 adapter 暴露的 planFileUpdateCount（trajectory 真命中）取真值
 * 旧版（W11.D2 粗估）：数 tools_called 内的所有 write/edit，无法区分写的是不是 plan 文件
 *
 * 兜底：如果 trajectory 缺失（adapter 未读到 session.traj）但 planFilePath 存在
 *      （plan 文件已落盘但 trace 失败），按 1 算（plan 文件确实被写过 1 次）
 */
function planUpdateCountFromAdapter(liveResult: SidCodeLiveResult): number {
  if (liveResult.planFileUpdateCount > 0) return liveResult.planFileUpdateCount;
  // tracker miss 兜底：plan 文件存在则至少有过一次 write
  return liveResult.planFilePath ? 1 : 0;
}

const judgeConfig: JudgeConfig = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1",
  model: process.env.JUDGE_MODEL || "claude-sonnet-4-6",
  promptPath: join(ROOT, "evals/_judge/prompt-v2.md"),
};

const liveConfig: SidCodeLiveConfig = {
  cwd: ROOT,
  // 不强制要求 ANTHROPIC_API_KEY：让 sid-code 子进程读 ~/.sid-code/config.yaml 的 anthropic_key
  // 也不透传 baseUrl：避免 SID_CODE_LLM_BASE_URL 覆盖 config.yaml 里的 dashscope/openai base_url
  // model 默认 deepseek-v4-pro：与 eval-runner.ts PROVIDER_REGISTRY 一致，
  // 让 baseline_scores key 形如 `sid_code_deepseek_v4_pro`，与 general baseline 同名空间。
  model: values.model || process.env.SID_CODE_MODEL || "deepseek-v4-pro",
  timeoutMs: parseInt(values.timeout || "480000", 10),
};

const cases = loadCases(values.case);
if (cases.length === 0) {
  console.error(`✗ 未找到 capability case${values.case ? ` (filter=${values.case})` : ""}`);
  process.exit(1);
}

const samplesN = Math.max(1, parseInt(values.samples || "1", 10));

console.log(`Mode      : ${values.execute ? "execute (真调 LLM Judge)" : "skip-llm-judge (省钱模式)"}`);
console.log(`Adapter   : sid-code-live`);
console.log(`Model     : ${liveConfig.model || "(用户 config 默认)"}`);
console.log(`Timeout   : ${liveConfig.timeoutMs}ms`);
console.log(`Samples   : ${samplesN}${samplesN > 1 ? " (中位数收敛)" : ""}`);
console.log(`Cases     : ${cases.length} 条 (${cases.map((c) => c.id).join(", ")})`);
console.log("");

const ts = Date.now();
const rawOutputPath = join(RAW_DIR, `capability-plan-${ts}.jsonl`);
const reportOutputPath = join(REPORT_DIR, `capability-plan-${ts}.json`);

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
  planUpdateCount: number;
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
    plan_file: string | null;
  };
  reasoning: string;
  samples: SampleSnapshot[];
  aggregatedRunStatus: string;
}

const results: CaseResult[] = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  console.log(
    `[${i + 1}/${cases.length}] ${c.id} (${c.dimension}) — 启动 sid-code-live ...${samplesN > 1 ? ` (samples=${samplesN})` : ""}`,
  );

  const { instruction, appendSystemPrompt } = buildInstruction(c);
  const sampleSnapshots: SampleSnapshot[] = [];
  let lastLive: SidCodeLiveResult | null = null;
  let lastDetails: Record<string, string | number | boolean> = {};
  let lastCheckSummary = "";
  let lastPlanContent = "";

  for (let s = 0; s < samplesN; s++) {
    const startedAt = Date.now();
    let live: SidCodeLiveResult;
    try {
      live = await runSidCodeLive(instruction, {
        ...liveConfig,
        appendSystemPrompt: appendSystemPrompt || undefined,
        // Plan mode 维度 → 强制 plan permission mode
        permissionMode: c.input.trigger_plan_mode ? "plan" : undefined,
      });
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
        planUpdateCount: 0,
      });
      continue;
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;
    lastLive = live;

    // 读 plan 文件内容
    let planContent = "";
    if (live.planFilePath) {
      try {
        planContent = readFileSync(live.planFilePath, "utf-8");
      } catch {
        planContent = "";
      }
    }
    lastPlanContent = planContent;

    const planUpdateCount = planUpdateCountFromAdapter(live);

    const graderInput: CapabilityGraderInput = {
      expected: c.expected,
      planContent,
      toolsCalled: live.output.tools_called,
      steps: live.output.steps,
      finalResponse: live.output.final_response,
      planUpdateCount,
    };

    const { assertResults, llmRule } = runAllChecks(c.grader, graderInput);

    // LLM Judge（execute 模式下）
    let llmScore: number | undefined;
    if (values.execute && llmRule && judgeConfig.apiKey) {
      const judgeInput = {
        task: instruction.slice(0, 1500),
        expected: {
          ...c.expected,
          // capability 没有 must_include_keywords，借 plan_must_cover 字段塞
          must_include_keywords: c.expected.plan_must_cover_any_of,
          must_call_tools: c.expected.execution_must_call_tools_any_of,
          max_steps: c.expected.max_steps,
        },
        agentResponse: planContent || live.output.final_response,
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
      planUpdateCount,
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
      plan_file: showLive?.planFilePath ?? null,
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
    (result as unknown as { _plan_content: string })._plan_content = lastPlanContent.slice(0, 3000);
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

// 写 raw outputs
const rawContent = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
await Bun.write(rawOutputPath, rawContent);

// 按 dimension 聚合
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
  avgScore: Math.round((results.reduce((s, r) => s + r.finalScore, 0) / results.length) * 100) / 100,
  passRate:
    Math.round((results.filter((r) => r.finalScore >= 4.0).length / results.length) * 100) / 100,
};

await Bun.write(
  reportOutputPath,
  JSON.stringify(
    {
      timestamp: ts,
      mode: values.execute ? "execute" : "skip-llm-judge",
      model: liveConfig.model,
      samples: samplesN,
      overall,
      by_dimension: dimensionSummary,
      cases: results.map((r) => ({
        id: r.id,
        dimension: r.dimension,
        score: r.finalScore,
        assert: r.assertScore,
        judge: r.llmScore,
        timed_out: r.agentSnapshot.timed_out,
        run_status: r.aggregatedRunStatus,
        samples_n: r.samples.length,
      })),
    },
    null,
    2,
  ),
);

console.log("\n" + "=".repeat(60));
console.log(`Plan capability eval done`);
console.log("=".repeat(60));
console.log(`  Total: ${overall.total} | avg=${overall.avgScore}/5 | pass=${(overall.passRate * 100).toFixed(0)}%`);
console.log(`  By dimension:`);
for (const [dim, s] of Object.entries(dimensionSummary)) {
  console.log(`    ${dim.padEnd(28)} avg=${s.avgScore} pass=${(s.passRate * 100).toFixed(0)}% (n=${s.count})`);
}
console.log(`\n  Raw  → ${rawOutputPath}`);
console.log(`  Report → ${reportOutputPath}`);

// --sync：把跑分回写到 evals/capability/plan/plan_*.yaml 的 baseline_scores
// 默认 off（与 eval-runner 对齐），需显式 --sync 才回写。
// S0-T02 / docs/eval/plan-capability-baseline-sync.md
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
      // A3-1 / A3-2：capability runner 不走 binary_redline 一票否决；mandatoryPass 默认 true
      // 让 dashboard 红线击穿率统计能正确包含 capability case（不当成"无 grader 的旧数据"）
      mandatoryPass: r.aggregatedRunStatus === "success",
      // capability runner 走独立 assert + llm_judge 公式，标 capability-plan-v1 与 general 5d-vN 区分
      graderType: "capability-plan-v1",
      // capability runner 目前不走 5 维 grader，标注独立版本以与 general baseline 区分
      // S1 上 task-specific scorer 时再 bump 到对应版本号
      formulaVersion: { grader: "capability-plan-v1" },
      samples,
    };
  });

  syncBaselineScores(baselineResults, {
    yamlDir: CAPABILITY_DIR,
    testerLabel: "eval:plan-capability",
  });
}
